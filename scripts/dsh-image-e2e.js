#!/usr/bin/env node
"use strict";

/**
 * Verify that DSH actually receives and interprets an inlined image.
 *
 * The unit tests prove the attachment is converted into an SdkEncodedImageBlock
 * with the right bytes; they cannot prove the runtime consumes it. This sends a
 * generated image whose content is knowable ("a solid red square") and checks the
 * model describes it, which fails loudly if the image block is dropped.
 *
 * Usage: node scripts/dsh-image-e2e.js
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const { DshRpcClient, defaultDshBin } = require("../src/adapters/runtime/dsh/rpc-client");
const { buildDshContentBlocks } = require("../src/adapters/runtime/dsh");

/** Minimal PNG encoder: one solid colour, no external dependency. */
function solidPng(width, height, [r, g, b]) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0; // filter: none
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      raw[offset] = r; raw[offset + 1] = g; raw[offset + 2] = b;
      offset += 3;
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0, 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let CRC_TABLE = null;
function crc32(buffer) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return crc ^ -1;
}

async function main() {
  const startedAt = Date.now();
  const stamp = () => `[${String(Date.now() - startedAt).padStart(6)}ms]`;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-dsh-image-"));
  const imagePath = path.join(workDir, "solid-red.png");

  // A 64x64 fully red image: unambiguous and cheap to describe.
  fs.writeFileSync(imagePath, solidPng(64, 64, [220, 20, 20]));
  process.stdout.write(`${stamp()} wrote ${imagePath} (${fs.statSync(imagePath).size} bytes)\n`);

  const blocks = buildDshContentBlocks({
    text: "What is the dominant colour of the attached image? Answer with the colour name only.",
    attachments: [{ absolutePath: imagePath }],
    readFileSync: fs.readFileSync,
  });
  process.stdout.write(`${stamp()} built ${blocks.length} content block(s): `
    + `${blocks.map((b) => b.type).join(",")}\n`);
  if (!blocks.some((block) => block.type === "image")) {
    process.stdout.write("FAIL: no image block was produced\n");
    process.exit(1);
  }

  const client = new DshRpcClient({
    dshBin: (process.env.CYBERBOSS_DSH_BIN || "").trim() || defaultDshBin(),
    cwd: projectRoot(),
    provider: "deepseek-official",
    model: process.env.CYBERBOSS_DSH_MODEL || "deepseek-flash",
    logger: { error() {}, log() {} },
  });

  const replyTexts = [];
  const turnEnded = { value: false };
  client.onNotification((method, params) => {
    if (method !== "session.event") return;
    const event = params?.event || {};
    if (event.type === "assistant/message") {
      for (const block of event.data?.message?.content || []) {
        if (block?.type === "text" && block.text) replyTexts.push(block.text);
      }
    }
    if (event.type === "turn/end") turnEnded.value = true;
  });

  let exitCode = 0;
  try {
    await client.initialize();
    process.stdout.write(`${stamp()} initialized\n`);
    const sessionId = `cb-image-${Date.now()}`;
    await client.prompt(sessionId, blocks);
    process.stdout.write(`${stamp()} prompt accepted\n`);

    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline && !turnEnded.value) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    const reply = replyTexts.join(" ").trim();
    process.stdout.write(`${stamp()} reply: ${JSON.stringify(reply)}\n`);
    if (!turnEnded.value) {
      process.stdout.write("FAIL: the turn never ended\n");
      exitCode = 1;
    } else if (!reply) {
      process.stdout.write("FAIL: the turn produced no text\n");
      exitCode = 1;
    } else if (!/red/i.test(reply)) {
      process.stdout.write(`FAIL: the model did not report the image colour (got ${JSON.stringify(reply)}); `
        + "the image block may have been dropped\n");
      exitCode = 1;
    } else {
      process.stdout.write("PASS: the runtime read the inlined image\n");
    }
  } catch (error) {
    process.stdout.write(`${stamp()} ERROR ${error?.stack || error}\n`);
    exitCode = 1;
  } finally {
    try { await client.close(); } catch {}
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
  process.exit(exitCode);
}

function projectRoot() {
  return path.resolve(__dirname, "..");
}

main();
