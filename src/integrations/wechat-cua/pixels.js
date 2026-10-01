// pixels.js - who sent this bubble? Answered with the screen, not with a guess.
//
// The UIA tree cannot answer it. Measured 2026-10-01 on a real 1:1 conversation
// (柳毓琳), every message bubble - incoming "hi" and outgoing "处理中" alike - comes
// back as a ListItem spanning the whole message area:
//
//   x=785 y=292 w=722 h=68  "hi"        <- from the peer
//   x=785 y=361 w=722 h=68  "处理中"     <- from this account
//
// Same frame, same role, same actions; the tree simply does not carry alignment.
// The screenshot does, and it carries it unambiguously: this client paints the
// account's own messages as a GREEN bubble with the avatar on the right, and the
// peer's messages as a WHITE bubble with the avatar on the left. Colour is a
// stronger signal than alignment here (it survives RTL text, images, wide layouts).
//
// So direction is decided by sampling the bubble's own `screenshot_frame` (the
// driver supplies it, already relative to the screenshot) and asking how much of
// that region is WeChat green.
//
// This module is deliberately dependency-free: PNG decoding is ~80 lines with
// node's zlib, and adding an image library to a bot whose whole point is being
// small and portable would be a poor trade.

const zlib = require("node:zlib");

/**
 * WeChat's outgoing-bubble green.
 *
 * Measured, not guessed: sampling a live 1:1 conversation on 2026-10-01 gives
 * (152, 240, 152) as the dominant bubble colour on this client's default theme -
 * NOT the (149, 236, 105) that "WeChat green" is usually quoted as. An exact match
 * with a tolerance therefore classified every outgoing message as incoming, with a
 * green share of ~0.004. The rule below is a hue test instead of a colour match, so
 * it survives theme drift (it accepts the old #95EC69 as well):
 *
 *   green channel bright, and clearly ahead of both red and blue.
 */
const looksGreen = (r, g, b) => g >= 180 && (g - r) >= 25 && (g - b) >= 25;
/** Reference colour, for documentation and logs only. */
const GREEN = { r: 152, g: 240, b: 152 };
/**
 * Share of the sampled band that must be green for a bubble to be "outgoing".
 *
 * Measured separation on a live conversation (band = middle-right of the row):
 * incoming 0.000 / 0.000, outgoing 0.119 / 0.224 / 0.316 / 0.423. The threshold
 * sits well inside that gap.
 */
const OUTGOING_SHARE = 0.05;
/**
 * Horizontal band of a message row that is actually sampled.
 *
 * A bubble row spans the whole message area, and the avatars sit at its extremes
 * (the peer's on the left, ours on the right). Sampling the middle-right keeps
 * avatar artwork out of the measurement - an avatar containing green would
 * otherwise vote for "outgoing" on an incoming message.
 */
const BAND_START = 0.35;
const BAND_WIDTH = 0.55;

/** Decode a non-interlaced 8-bit PNG into {width, height, rgba}. */
function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) {
    throw new Error("decodePng needs a PNG buffer");
  }
  if (buffer.readUInt32BE(0) !== 0x89504e47) {
    throw new Error("not a PNG (bad signature)");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  if (!width || !height) throw new Error("PNG has no IHDR");
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}`);
  if (interlace !== 0) throw new Error("interlaced PNG is not supported");
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);
  let cursor = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor];
    cursor += 1;
    const line = Buffer.from(raw.subarray(cursor, cursor + stride));
    cursor += stride;
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? line[i - channels] : 0;
      const up = previous[i];
      const upLeft = i >= channels ? previous[i - channels] : 0;
      switch (filter) {
        case 0: break;
        case 1: line[i] = (line[i] + left) & 0xff; break;
        case 2: line[i] = (line[i] + up) & 0xff; break;
        case 3: line[i] = (line[i] + ((left + up) >> 1)) & 0xff; break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const predictor = (pa <= pb && pa <= pc) ? left : (pb <= pc ? up : upLeft);
          line[i] = (line[i] + predictor) & 0xff;
          break;
        }
        default: throw new Error(`unknown PNG filter ${filter}`);
      }
    }
    for (let x = 0; x < width; x += 1) {
      const src = x * channels;
      const dst = (y * width + x) * 4;
      if (channels === 1) {
        out[dst] = out[dst + 1] = out[dst + 2] = line[src];
        out[dst + 3] = 255;
      } else if (channels === 2) {
        out[dst] = out[dst + 1] = out[dst + 2] = line[src];
        out[dst + 3] = line[src + 1];
      } else if (channels === 3) {
        out[dst] = line[src];
        out[dst + 1] = line[src + 1];
        out[dst + 2] = line[src + 2];
        out[dst + 3] = 255;
      } else {
        out[dst] = line[src];
        out[dst + 1] = line[src + 1];
        out[dst + 2] = line[src + 2];
        out[dst + 3] = line[src + 3];
      }
    }
    previous = line;
  }
  return { width, height, rgba: out };
}

/**
 * Share of a message row that is the outgoing-bubble green, sampled over the
 * middle-right band so avatars cannot vote (see BAND_START).
 *
 * @param {{width:number,height:number,rgba:Buffer}} image decoded screenshot
 * @param {{x:number,y:number,w:number,h:number}} rect the bubble's row, in image coordinates
 */
function greenShare(image, rect) {
  const x0 = Math.max(0, Math.floor(rect.x + (rect.w * BAND_START)));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(image.width, Math.ceil(rect.x + (rect.w * (BAND_START + BAND_WIDTH))));
  const y1 = Math.min(image.height, Math.ceil(rect.y + rect.h));
  if (x1 <= x0 || y1 <= y0) return 0;
  let green = 0;
  let total = 0;
  // Sampling every other pixel in both axes is plenty for a fill colour and keeps
  // a 722x68 row at a few thousand checks instead of fifty thousand.
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * image.width + x) * 4;
      total += 1;
      if (image.rgba[i + 3] > 200 && looksGreen(image.rgba[i], image.rgba[i + 1], image.rgba[i + 2])) {
        green += 1;
      }
    }
  }
  return total ? green / total : 0;
}

/**
 * Direction of one message bubble.
 *
 * @returns {"outgoing"|"incoming"|"unknown"} "unknown" when the region cannot be
 *   sampled at all (no screenshot, no frame) - never a silent "incoming", because
 *   treating an unreadable bubble as the peer's is exactly the mistake that makes
 *   a bot answer itself.
 */
function classifyBubbleDirection(image, rect) {
  if (!image || !rect || !rect.w || !rect.h) {
    return "unknown";
  }
  return greenShare(image, rect) >= OUTGOING_SHARE ? "outgoing" : "incoming";
}

module.exports = {
  decodePng,
  greenShare,
  classifyBubbleDirection,
  looksGreen,
  GREEN,
  OUTGOING_SHARE,
};
