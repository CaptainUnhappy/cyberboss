#!/usr/bin/env node
/**
 * Live media probe: can Cua put an image (and a file) into a WeChat chat?
 *
 *   node scripts/cua-wechat-media-live.js [--chat "文件传输助手"] [--no-send]
 *
 * It generates a small PNG locally (no external assets), sends it through the
 * clipboard + Ctrl+V + Return path, and then reads the conversation back to see
 * what arrived. Both focus costs are reported, because that is the number that
 * decides whether media sending is acceptable on a desktop someone is using.
 *
 * Target defaults to 文件传输助手 (the self-chat).
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const { CuaSession, findWeChatWindow } = require("../src/integrations/wechat-cua/client");
const { sendMedia, brief } = require("../src/integrations/wechat-cua/media");

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (line) => console.log(`[${stamp()}] ${line}`);

/** A minimal RGB PNG with a solid colour band, written by hand (no deps). */
function writeProbePng(file) {
  const width = 240;
  const height = 120;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y += 1) {
    raw[o] = 0; // filter: none
    o += 1;
    for (let x = 0; x < width; x += 1) {
      const band = Math.floor(x / 40) % 3;
      raw[o] = band === 0 ? 0x1e : band === 1 ? 0xff : 0x20;
      raw[o + 1] = band === 0 ? 0x88 : band === 1 ? 0xcc : 0x20;
      raw[o + 2] = band === 0 ? 0xe5 : band === 1 ? 0x33 : 0x80;
      o += 3;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0, 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
  return file;
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buf) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return crc ^ -1;
}

function main() {
  const argv = process.argv.slice(2);
  const chat = argv.includes("--chat") ? argv[argv.indexOf("--chat") + 1] : "文件传输助手";
  const send = !argv.includes("--no-send");
  const foregroundPaste = argv.includes("--foreground-paste");

  const session = new CuaSession("cyberboss-media");
  const target = findWeChatWindow(session);
  log(`target : ${JSON.stringify(chat)} (pid=${target.pid} id=${target.window_id})`);

  const image = writeProbePng(path.join(os.tmpdir(), `cua-media-probe-${Date.now()}.png`));
  log(`image  : ${image} (${fs.statSync(image).size} bytes)`);

  const started = Date.now();
  const result = sendMedia(target, chat, { imagePath: image, session, send, foregroundPaste });
  log(`elapsed: ${Date.now() - started} ms`);
  for (const step of result.steps) {
    log(`  ${step.step.padEnd(9)} ${step.route ? `route=${step.route} cost=${step.cost || "-"}` : brief(step.outcome)}`);
  }
  log(`ok     : ${result.ok}  sent=${result.sent}  focusCosts=${JSON.stringify(result.focusCosts || [])}`);
  log(`verify : ${result.verify}`);
  log(result.ok ? "VERDICT: media send path works" : "VERDICT: media send did NOT work");
  process.exit(result.ok ? 0 : 1);
}

main();
