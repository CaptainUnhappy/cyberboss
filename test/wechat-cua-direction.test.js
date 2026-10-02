#!/usr/bin/env node
/**
 * Offline tests for "who sent this message?".
 *
 * The UIA tree cannot answer it: measured 2026-10-01 on a real 1:1 conversation,
 * an incoming "hi" and an outgoing "处理中" are both full-width ListItems with the
 * same role, the same actions and the same frame. The screenshot can answer it -
 * this client paints its own messages green and the peer's white - so direction is
 * decided from pixels, and these tests pin both halves: the PNG decoding, and the
 * consequence (an outgoing bubble must never be answered as if the peer wrote it,
 * unless it is the operator's own same-account message, which is recorded as such).
 *
 * Run: node test/wechat-cua-direction.test.js
 */

const assert = require("assert");
const zlib = require("node:zlib");

const { decodePng, classifyBubbleDirection, greenShare } = require("../src/integrations/wechat-cua/pixels");
const { readConversation, PreviewInboundSource } = require("../src/integrations/wechat-cua/inbound");
const { CuaSession } = require("../src/integrations/wechat-cua/client");

const TARGET = { pid: 1, window_id: 2 };
const WHITE = [250, 250, 250, 255];
/** The colour this client actually paints, measured 2026-10-01. */
const GREEN = [152, 240, 152, 255];
/** The colour "WeChat green" is usually quoted as - must classify the same way. */
const LEGACY_GREEN = [149, 236, 105, 255];

/* ---------- a real PNG encoder, so the decoder is tested against bytes ---------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Encode an RGBA buffer as a non-interlaced 8-bit PNG (the shape the driver sends). */
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour + alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A screenshot-sized canvas with painted rectangles. */
function canvas(width, height, rects) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = WHITE[0]; rgba[i + 1] = WHITE[1]; rgba[i + 2] = WHITE[2]; rgba[i + 3] = 255;
  }
  for (const { x, y, w, h, color } of rects) {
    for (let py = y; py < y + h; py += 1) {
      for (let px = x; px < x + w; px += 1) {
        const i = (py * width + px) * 4;
        rgba[i] = color[0]; rgba[i + 1] = color[1]; rgba[i + 2] = color[2]; rgba[i + 3] = color[3];
      }
    }
  }
  return rgba;
}

/* ---------------------------------- the tests ---------------------------------- */

test_png_round_trip();
test_direction_comes_from_the_bubble_colour();
test_an_unreadable_bubble_is_unknown_not_incoming();
test_read_conversation_labels_each_bubble();
test_an_outgoing_bubble_is_never_answered_as_the_peer();
test_the_operators_own_message_is_recorded_not_dropped();
test_direction_is_free_when_the_peer_is_already_open();
console.log("all direction tests passed");

function test_png_round_trip() {
  const rgba = canvas(8, 4, [{ x: 2, y: 1, w: 3, h: 2, color: GREEN }]);
  const png = encodePng(8, 4, rgba);
  const decoded = decodePng(png);
  assert.strictEqual(decoded.width, 8);
  assert.strictEqual(decoded.height, 4);
  assert.deepStrictEqual([...decoded.rgba.subarray(0, 4)], WHITE, "the corner stays white");
  const inside = ((1 * 8) + 2) * 4;
  assert.deepStrictEqual([...decoded.rgba.subarray(inside, inside + 4)], GREEN, "the painted rectangle survives the round trip");
  console.log("ok   a PNG decodes back to the pixels that were encoded");
}

function test_direction_comes_from_the_bubble_colour() {
  const rgba = canvas(60, 20, [{ x: 8, y: 4, w: 40, h: 12, color: GREEN }]);
  const image = decodePng(encodePng(60, 20, rgba));
  assert.strictEqual(classifyBubbleDirection(image, { x: 0, y: 0, w: 60, h: 20 }), "outgoing");
  assert.ok(greenShare(image, { x: 0, y: 0, w: 60, h: 20 }) > 0.3);
  // A region that misses the green bubble entirely is the peer's.
  assert.strictEqual(classifyBubbleDirection(image, { x: 0, y: 18, w: 60, h: 2 }), "incoming");
  // Theme drift: the older, more saturated bubble green must classify identically,
  // otherwise a client update would silently turn every reply into "incoming".
  const legacy = decodePng(encodePng(60, 20, canvas(60, 20, [{ x: 8, y: 4, w: 40, h: 12, color: LEGACY_GREEN }])));
  assert.strictEqual(classifyBubbleDirection(legacy, { x: 0, y: 0, w: 60, h: 20 }), "outgoing");
  console.log("ok   a green bubble is outgoing and a white one is the peer's");
}

function test_an_unreadable_bubble_is_unknown_not_incoming() {
  // "unknown" must never be laundered into "the peer sent it": that is exactly the
  // mistake that makes a bot answer its own message.
  assert.strictEqual(classifyBubbleDirection(null, { x: 0, y: 0, w: 10, h: 10 }), "unknown");
  assert.strictEqual(classifyBubbleDirection({ width: 10, height: 10, rgba: Buffer.alloc(400) }, null), "unknown");
  assert.strictEqual(classifyBubbleDirection({ width: 10, height: 10, rgba: Buffer.alloc(400) }, { x: 0, y: 0, w: 0, h: 0 }), "unknown");
  console.log("ok   a bubble that cannot be sampled is 'unknown', never 'incoming'");
}

/**
 * A snapshot with a chat list AND an open conversation, like the real one.
 *
 * The container element matters: `readConversation` separates rows from bubbles by
 * width relative to the widest element, and in the real tree the widest thing is
 * the window's message-area container (~1100), not a bubble (722). Building the
 * fixture without it would quietly test a tree that cannot occur.
 */
function buildSnapshot({ peer = "柳毓琳", preview = "", bubbles = [] } = {}) {
  const width = 1200;
  const height = 400;
  const rects = bubbles
    .map((bubble, index) => (bubble.outgoing ? { x: 780, y: 20 + (index * 60), w: 380, h: 50, color: GREEN } : null))
    .filter(Boolean);
  const elements = [
    { role: "Group", label: "", element_token: "container", frame: { x: 0, y: 0, w: width, h: height } },
    { role: "ListItem", label: `${peer}\n${preview}\n13:00\n`, element_token: "row-1", frame: { x: 485, y: 300, w: 300, h: 78 } },
    { role: "Edit", label: peer, value: "", element_token: "box-1", frame: { x: 400, y: 700, w: 700, h: 60 } },
    ...bubbles.map((bubble, index) => ({
      role: "ListItem",
      label: bubble.text,
      element_index: 50 + index,
      element_token: `bubble-${index}`,
      frame: { x: 400, y: 10 + (index * 60), w: 722, h: 51 },
      screenshot_frame: { x: 400, y: 10 + (index * 60), w: 722, h: 51 },
    })),
  ];
  return {
    elements,
    element_count: elements.length,
    screenshot_png_b64: encodePng(width, height, canvas(width, height, rects)).toString("base64"),
    screenshot_width: width,
    screenshot_height: height,
  };
}

function test_read_conversation_labels_each_bubble() {
  const session = new CuaSession("test");
  session.snapshot = () => buildSnapshot({
    bubbles: [
      { text: "hi", outgoing: false },
      { text: "处理中", outgoing: true },
    ],
  });
  const messages = readConversation(session, TARGET);
  assert.deepStrictEqual(messages.map((m) => m.text), ["hi", "处理中"]);
  assert.deepStrictEqual(messages.map((m) => m.direction), ["incoming", "outgoing"]);
  console.log("ok   readConversation reports the direction of every bubble it returns");
}

function test_an_outgoing_bubble_is_never_answered_as_the_peer() {
  // The row changed; the deep read says the newest bubble is ours. The ledger here
  // claims NOTHING (a restarted bot has an empty ledger), so text matching cannot
  // save us - direction alone has to stop the bot from answering its own message.
  const session = new CuaSession("test");
  let phase = 0;
  session.snapshot = () => {
    phase += 1;
    const preview = phase === 1 ? "old" : "bot said this";
    return buildSnapshot({
      preview,
      bubbles: preview === "old" ? [] : [{ text: "bot said this", outgoing: true }],
    });
  };
  const source = new PreviewInboundSource(TARGET, {
    session,
    deepRead: true,
    openConversation: () => true,
    allowPeers: ["柳毓琳"],
  });
  source.poll({ isOwnEcho: () => false }); // prime
  const events = source.poll({ isOwnEcho: () => false });
  const incoming = events.filter((event) => event.direction !== "outgoing");
  assert.strictEqual(incoming.length, 0, `an outgoing bubble must never become an inbound message: ${JSON.stringify(events)}`);
  assert.strictEqual(events.length, 1, "it is still recorded as this account's own message");
  assert.strictEqual(source.stats.selfManual, 1);
  console.log("ok   an outgoing bubble is never answered as if the peer had written it");
}

function test_the_operators_own_message_is_recorded_not_dropped() {
  // Same green bubble, nobody claims it: the operator typed it in this account
  // (here or on another signed-in device). Recorded as such - not answered like a
  // peer's message, and not silently discarded either.
  const session = new CuaSession("test");
  let phase = 0;
  session.snapshot = () => {
    phase += 1;
    const preview = phase === 1 ? "old" : "typed by the operator";
    return buildSnapshot({
      preview,
      bubbles: preview === "old" ? [] : [{ text: "typed by the operator", outgoing: true }],
    });
  };
  const source = new PreviewInboundSource(TARGET, {
    session,
    deepRead: true,
    openConversation: () => true,
    allowPeers: ["柳毓琳"],
  });
  source.poll({ isOwnEcho: () => false }); // baseline
  const events = source.poll({ isOwnEcho: () => false });
  assert.strictEqual(events.length, 1, `expected the operator's message to be recorded: ${JSON.stringify(events)}`);
  assert.strictEqual(events[0].direction, "outgoing");
  assert.strictEqual(events[0].origin, "self_manual");
  assert.strictEqual(events[0].text, "typed by the operator");
  assert.strictEqual(source.stats.selfManual, 1);
  console.log("ok   a same-account message is recorded as the operator's, with its direction");
}

function test_direction_is_free_when_the_peer_is_already_open() {
  // Opening a conversation costs a foreground activation (150-300ms, measured). But
  // when the changed peer IS the open conversation, its bubbles are one background
  // snapshot away - so the answer to "did the user send this?" costs nothing.
  const session = new CuaSession("test");
  let phase = 0;
  session.snapshot = () => {
    phase += 1;
    return phase === 1
      ? buildSnapshot({ preview: "old", bubbles: [] })
      : buildSnapshot({ preview: "typed by the user", bubbles: [{ text: "typed by the user", outgoing: false }] });
  };
  const source = new PreviewInboundSource(TARGET, {
    session,
    deepRead: false,                       // no clicking allowed
    openConversation: () => { throw new Error("must not open a conversation to read direction"); },
    allowPeers: ["柳毓琳"],
  });
  source.poll({ isOwnEcho: () => false }); // prime
  const events = source.poll({ isOwnEcho: () => false });
  assert.strictEqual(events.length, 1, `expected one inbound event: ${JSON.stringify(events)}`);
  assert.strictEqual(events[0].direction, "incoming");
  assert.strictEqual(events[0].confidence, "bubble-direction", "the direction must come from the bubbles, not a preview guess");
  assert.ok(source.stats.directionWithoutClick >= 1, "the direction was read without any click");
  assert.strictEqual(source.stats.deepReads, 0, "no deep read means no conversation was opened");
  console.log("ok   the direction of an already-open conversation is read without any click");
}
