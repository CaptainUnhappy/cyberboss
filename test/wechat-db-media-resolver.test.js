#!/usr/bin/env node
/**
 * The image resolver's two "do not waste the desktop's time" invariants, checked
 * against the real reader on a synthetic attach folder.
 *
 * Both were found by measurement, not by reading the code (2026-10-03):
 *
 *   * every poll waited the full `image_wait_ms` (8s) for a picture whose original
 *     is a permanently blank HEVC frame, so a warm-cache poll cost 8.2s forever;
 *   * the blank-frame marker file written into the cache was newer than the
 *     published `.png`, which invalidated the cached winner on every poll and
 *     re-ran ffmpeg each time.
 *
 * Neither needs WeChat or a database key: the resolver only looks at the account
 * directory and its own cache, and a `.dat` can be built by hand (the V2 container
 * is `[07 08 'V2' 08 07][aes_size][xor_size][pad][AES-128-ECB][raw][XOR tail]`, and
 * the AES key can be pinned instead of derived).
 *
 * Run: node --test test/wechat-db-media-resolver.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const READER = path.join(ROOT, "scripts", "wechat-db-inbox-read.py");
const TALKER = "filehelper";
// 16 ASCII bytes, because `decode_dat` uses the key string as raw AES key material.
const AES_KEY = "cyberboss-probe1";

function pythonCommand() {
  for (const candidate of [process.env.CYBERBOSS_WECHAT_DB_PYTHON, "python", "python3"]) {
    if (!candidate) continue;
    const probe = spawnSync(candidate, ["-c", "import Crypto, zstandard"], { encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }
  return "";
}

const PYTHON = pythonCommand();

/**
 * A V2 `.dat` holding `payload`.
 *
 * The AES section cannot be skipped: the reader uses "the AES header decrypted to
 * something that looks like an image" as its proof that the key is right, so
 * `aes_size = 0` is treated as a corrupted file. Hence the first 15 bytes are
 * really encrypted (PKCS7-padded to one block) and the rest rides in the
 * unencrypted middle, which is exactly how WeChat lays these out.
 */
function dat(payload) {
  const header = Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07]);
  const head = payload.subarray(0, 15);
  const cipher = crypto.createCipheriv("aes-128-ecb", Buffer.from(AES_KEY, "ascii"), null);
  cipher.setAutoPadding(true);
  const encrypted = Buffer.concat([cipher.update(head), cipher.final()]);
  const sizes = Buffer.alloc(8);
  sizes.writeUInt32LE(head.length, 0); // aes_size: the real plaintext length
  sizes.writeUInt32LE(0, 4);           // xor_size: no XOR tail
  const pad = Buffer.alloc(1);
  return Buffer.concat([header, sizes, pad, encrypted, payload.subarray(15)]);
}

/** A real PNG of `width`x`height`, uniform colour (so `_is_blank_png` sees it). */
function png(width, height, rgb = [10, 120, 200]) {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      raw[row + 1 + x * 3] = rgb[0];
      raw[row + 2 + x * 3] = rgb[1];
      raw[row + 3 + x * 3] = rgb[2];
    }
  }
  const chunk = (type, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // truecolour
  const zlib = require("node:zlib");
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let crcTable = null;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wxdb-media-"));
  const account = path.join(root, "wxid_probe_account");
  const folder = path.join(account, "msg", "attach",
    crypto.createHash("md5").update(TALKER).digest("hex"), "2026-10", "Img");
  fs.mkdirSync(folder, { recursive: true });
  return { root, account, folder, cache: path.join(root, "cache") };
}

/**
 * Run the reader's own code against the sandbox, in its own process, and print
 * JSON: the resolver and the account layout are the real ones, only the data is
 * synthetic (which is the point - a real picture cannot be made to be "a blank
 * HEVC original on purpose").
 */
function resolveTwice(box, md5, { waitMs = 0 } = {}) {
  const script = `
import importlib.util, json, sys, time
from pathlib import Path
root, account, cache, md5, talker, wait_ms, aes_key = sys.argv[1:8]
spec = importlib.util.spec_from_file_location("ir", str(Path(root) / "scripts" / "wechat-db-inbox-read.py"))
ir = importlib.util.module_from_spec(spec); spec.loader.exec_module(ir)
media = ir.MediaResolver(Path(account), Path(cache), aes_key=aes_key, xor_key=-1, ffmpeg="")
media.image_wait_ms = int(wait_ms)
out = []
for _ in range(2):
    media.start_snapshot_budget()
    t0 = time.monotonic()
    path, reason = media.resolve_image(md5, talker, 0)
    media.end_snapshot_budget()
    out.append({"path": path, "reason": reason, "costMs": round((time.monotonic() - t0) * 1000),
                "quality": media.resolution.get("quality"),
                "size": f"{media.resolution.get('width')}x{media.resolution.get('height')}",
                "source": media.resolution.get("source")})
print(json.dumps({"runs": out, "stats": media.stats}))
`;
  const result = spawnSync(PYTHON, [
    "-c", script, ROOT, box.account, box.cache, md5, TALKER, String(waitMs), AES_KEY,
  ], { encoding: "utf8", cwd: ROOT });
  if (result.status !== 0) {
    throw new Error(`reader run failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout.trim().split("\n").pop());
}

test("a preview is upgraded once its original lands, and the cache is reused", { skip: !PYTHON }, () => {
  const box = sandbox();
  const md5 = "a".repeat(32);
  // Only the preview exists: the resolver must pick it and say so.
  fs.writeFileSync(path.join(box.folder, `${md5}_t.dat`), dat(png(120, 60)));
  const first = resolveTwice(box, md5, { waitMs: 0 });
  assert.equal(first.runs[0].quality, "thumbnail");
  assert.equal(first.runs[0].size, "120x60");

  // The original arrives (a new file in the same folder): the cached preview must
  // not be reused, because the thing it came from is no longer the best there is.
  fs.writeFileSync(path.join(box.folder, `${md5}.dat`), dat(png(640, 480)), { flag: "w" });
  const second = resolveTwice(box, md5, { waitMs: 0 });
  assert.equal(second.runs[0].quality, "original",
    "a landing original must win over the cached preview");
  assert.equal(second.runs[0].size, "640x480");
  assert.match(second.runs[0].source, /_h\.dat$|^[0-9a-f]{32}\.dat$|\(cache\)/);
});

test("a cached answer is not reused once its source is gone", { skip: !PYTHON }, () => {
  const box = sandbox();
  const md5 = "b".repeat(32);
  const original = path.join(box.folder, `${md5}.dat`);
  fs.writeFileSync(original, dat(png(640, 480)));
  const first = resolveTwice(box, md5, { waitMs: 0 });
  assert.equal(first.runs[0].quality, "original");

  // The client's file disappears; only the preview is left. The reader used to
  // keep answering "original" here, because the published copy was newer than the
  // remaining source - that is the bug this asserts against.
  fs.rmSync(original);
  fs.writeFileSync(path.join(box.folder, `${md5}_t.dat`), dat(png(80, 40)));
  const second = resolveTwice(box, md5, { waitMs: 0 });
  assert.equal(second.runs[0].quality, "thumbnail",
    "with the original gone, the answer must be the preview, not the memory of it");
  assert.equal(second.runs[0].size, "80x40");
});

test("the wait for an original is spent once per picture, not on every poll", { skip: !PYTHON }, () => {
  const box = sandbox();
  const md5 = "c".repeat(32);
  fs.writeFileSync(path.join(box.folder, `${md5}_t.dat`), dat(png(80, 40)));
  const run = resolveTwice(box, md5, { waitMs: 700 });
  assert.ok(run.runs[0].costMs >= 600, `the first look waits for the original (${run.runs[0].costMs}ms)`);
  assert.ok(run.runs[1].costMs < 200,
    `the second look must not wait again (${run.runs[1].costMs}ms) - an unchanged disk cannot answer differently`);
  assert.equal(run.runs[1].quality, "thumbnail");
});
