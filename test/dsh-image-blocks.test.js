const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildDshContentBlocks,
  imageMimeForPath,
  isSupportedImageMime,
} = require("../src/adapters/runtime/dsh");

/**
 * Cyberboss passes the runtime attachment *references*, not bytes: the Codex
 * adapter reads `attachment.absolutePath` and sends a local-path image block.
 * DSH's SdkEncodedImageBlock takes base64, so the adapter must read the file.
 * An adapter that only understood {data, mimeType} would silently drop every
 * inbound WeChat image, so this contract is pinned here.
 */
function fakeRead(bytes = "IMG") {
  return () => Buffer.from(bytes);
}

test("an absolutePath image attachment is inlined for the DSH wire", () => {
  const blocks = buildDshContentBlocks({
    text: "看这张图",
    attachments: [{ absolutePath: "C:/state/inbox/photo.png" }],
    readFileSync: fakeRead("PNGDATA"),
  });
  assert.deepEqual(blocks, [
    { type: "text", text: "看这张图" },
    { type: "image", data: Buffer.from("PNGDATA").toString("base64"), mimeType: "image/png" },
  ]);
});

test("the image MIME type is inferred from the extension when not declared", () => {
  for (const [file, mime] of [
    ["a.png", "image/png"],
    ["a.jpg", "image/jpeg"],
    ["a.jpeg", "image/jpeg"],
    ["a.webp", "image/webp"],
    ["a.gif", "image/gif"],
  ]) {
    const blocks = buildDshContentBlocks({
      attachments: [{ absolutePath: `/inbox/${file}` }],
      readFileSync: fakeRead(),
    });
    assert.equal(blocks.length, 1, file);
    assert.equal(blocks[0].type, "image", file);
    assert.equal(blocks[0].mimeType, mime, file);
  }
});

test("an already-inlined image is passed through without touching the disk", () => {
  let readCalled = false;
  const blocks = buildDshContentBlocks({
    attachments: [{ data: "QUJD", mimeType: "image/jpeg" }],
    readFileSync: () => { readCalled = true; return Buffer.from("x"); },
  });
  assert.deepEqual(blocks, [{ type: "image", data: "QUJD", mimeType: "image/jpeg" }]);
  assert.equal(readCalled, false, "inline data must not trigger a file read");
});

test("a non-image attachment is referenced as text instead of being dropped", () => {
  const blocks = buildDshContentBlocks({
    attachments: [{ absolutePath: "/inbox/notes.txt" }],
    readFileSync: fakeRead(),
  });
  assert.deepEqual(blocks, [{ type: "text", text: "[attachment] /inbox/notes.txt" }]);
});

test("an unreadable image does not abort the turn", () => {
  const blocks = buildDshContentBlocks({
    text: "hi",
    attachments: [{ absolutePath: "/inbox/gone.png" }],
    readFileSync: () => { throw new Error("ENOENT"); },
  });
  assert.deepEqual(blocks, [{ type: "text", text: "hi" }],
    "the text must still reach the model when an attachment cannot be read");
});

test("empty or absent input yields no blocks and text-only turns stay text-only", () => {
  assert.deepEqual(buildDshContentBlocks({ text: "hi", attachments: [], readFileSync: fakeRead() }),
    [{ type: "text", text: "hi" }]);
  assert.deepEqual(buildDshContentBlocks({ readFileSync: fakeRead() }), []);
  assert.deepEqual(buildDshContentBlocks(), []);
  assert.deepEqual(buildDshContentBlocks({ attachments: [{}], readFileSync: fakeRead() }), []);
});

test("only the raster types DSH admits inline are treated as images", () => {
  for (const mime of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
    assert.equal(isSupportedImageMime(mime), true, mime);
  }
  for (const mime of ["image/tiff", "image/bmp", "image/svg+xml", "", "text/plain"]) {
    assert.equal(isSupportedImageMime(mime), false, mime);
  }
  assert.equal(imageMimeForPath("/a/b.PNG"), "image/png", "extension matching is case-insensitive");
  assert.equal(imageMimeForPath("/a/b.txt"), "");
});

test("a real PNG on disk round-trips into a base64 image block", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-dsh-image-"));
  try {
    // Minimal valid PNG signature + IHDR; the adapter only transports bytes.
    const bytes = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const file = path.join(dir, "real.png");
    fs.writeFileSync(file, bytes);

    const blocks = buildDshContentBlocks({
      attachments: [{ absolutePath: file }],
      readFileSync: fs.readFileSync,
    });

    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, "image");
    assert.equal(blocks[0].mimeType, "image/png");
    assert.equal(Buffer.from(blocks[0].data, "base64").equals(bytes), true,
      "the transported bytes must equal the file contents");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
