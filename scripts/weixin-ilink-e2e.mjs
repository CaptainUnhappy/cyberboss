// Self-contained end-to-end test of the WeChat (iLink) bot channel.
//
// The iLink protocol requires every outbound `sendmessage` to carry the
// `context_token` delivered by an inbound user message; without it the server
// answers `ret: -2, errmsg: "prepare failed"`. So an end-to-end test cannot be
// driven from the agent side alone — it needs one inbound message to open the
// window, and then everything must happen immediately, inside that window.
//
// This script therefore does both halves itself:
//   1. long-poll `getupdates` with its OWN sync cursor (it does not reuse or
//      overwrite the plugin's persisted `getUpdatesBuf`, so it cannot steal the
//      plugin's message stream), waiting for one inbound message;
//   2. immediately run the send matrix with the token from that message.
//
// Usage:
//   node weixin-e2e.mjs --file <path> [--video <path>] [--minutes 30]
import { createHash, randomBytes, randomUUID, createCipheriv } from 'node:crypto';
import { readFileSync, statSync, appendFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const CREDENTIALS = 'C:\\Users\\79388\\.dsh\\.credentials.yaml';
const REF = 'DSH_WEIXIN_BOT_TOKEN_A245FD04968C7A4262B20A5D';
const BASE_URL = 'https://ilinkai.weixin.qq.com/';
const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';
const CDN_HOST = 'novac2c.cdn.weixin.qq.com';
const OWNER = 'o9cq801fW13sRZ4HDX4FqKb3lHDs@im.wechat';
const LOG = 'D:\\Projects\\cyberboss\\tmp\\weixin-e2e.log';
// Rewritten on every poll cycle so liveness is checkable at a glance.
const POLL_MARKER = 'D:\\Projects\\cyberboss\\tmp\\weixin-e2e-polls.json';

const PROTOCOL_VERSION = '2.4.6';
const APP_ID = 'bot';
const CLIENT_VERSION = (2 << 16) | (4 << 8) | 6;
const LONG_POLL_MS = 35_000;

const args = process.argv.slice(2);
const argOf = (name, fallback = '') => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const fileToSend = argOf('--file');
const videoToSend = argOf('--video');
const minutes = Number(argOf('--minutes', '30'));
const LIST_ONLY = args.includes('--list-only');
// Back-to-back sends inside a short window risk provider throttling and can make
// the messages land out of order in the chat, which defeats the point of a
// side-by-side comparison. Sequential mode spaces them out.
const SEQUENTIAL = args.includes('--sequential');
const GAP_MS = Number(argOf('--gap-ms', '4000'));

function log(line = '') {
  const stamped = line ? `[${new Date().toISOString()}] ${line}` : '';
  console.log(stamped);
  try { if (stamped) appendFileSync(LOG, `${stamped}\n`); } catch { /* best effort */ }
}

function readToken() {
  const raw = readFileSync(CREDENTIALS, 'utf8');
  const line = raw.split(/\r?\n/).find((l) => l.trim().startsWith(`${REF}:`));
  if (!line) throw new Error(`credential ${REF} not found`);
  return line.slice(line.indexOf(':') + 1).trim().replace(/^["']|["']$/g, '');
}

const token = readToken();
const headers = () => ({
  'iLink-App-Id': APP_ID,
  'iLink-App-ClientVersion': String(CLIENT_VERSION),
  'content-type': 'application/json',
  AuthorizationType: 'ilink_bot_token',
  Authorization: `Bearer ${token}`,
  'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64'),
});
const baseInfo = () => ({ channel_version: PROTOCOL_VERSION, bot_agent: 'DeepSeekHarness/1.1.0' });

async function post(endpoint, body, { timeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL(endpoint, BASE_URL), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: response.status, parsed, text };
  } finally {
    clearTimeout(timer);
  }
}

function rejectionOf(parsed) {
  if (!parsed || typeof parsed !== 'object') return '';
  for (const key of ['errcode', 'ret', 'code']) {
    if (typeof parsed[key] === 'number' && parsed[key] !== 0) return `${key}=${parsed[key]}`;
  }
  return '';
}

const aesEcbPaddedSize = (size) => Math.ceil((size + 1) / 16) * 16;

function resolveUploadUrl(response, fileKey) {
  const full = typeof response?.upload_full_url === 'string' ? response.upload_full_url.trim() : '';
  const param = typeof response?.upload_param === 'string' ? response.upload_param.trim() : '';
  const url = full ? new URL(full) : (() => {
    if (!param) throw new Error('getuploadurl returned neither upload_full_url nor upload_param');
    const composed = new URL(`${CDN_BASE}/upload`);
    composed.searchParams.set('encrypted_query_param', param);
    composed.searchParams.set('filekey', fileKey);
    return composed;
  })();
  if (url.protocol !== 'https:' || url.hostname !== CDN_HOST
    || (url.port && url.port !== '443') || url.pathname !== '/c2c/upload') {
    throw new Error(`untrusted upload url: ${url.origin}${url.pathname}`);
  }
  url.hash = '';
  return url;
}

/** One outbound attempt. Returns { ok, detail } and never throws. */
async function attempt(label, buildBody, { media } = {}) {
  log(`--- ${label}`);
  try {    let body = buildBody();
    if (media) {
      const { filePath, mediaType, itemOf } = media;
      const bytes = readFileSync(filePath);
      const fileName = basename(filePath);
      const filekey = randomBytes(16).toString('hex');
      const aeskey = randomBytes(16);
      const ciphertextSize = aesEcbPaddedSize(bytes.length);
      const upload = await post('ilink/bot/getuploadurl', {
        filekey,
        media_type: mediaType,
        to_user_id: OWNER,
        rawsize: bytes.length,
        rawfilemd5: createHash('md5').update(bytes).digest('hex'),
        filesize: ciphertextSize,
        no_need_thumb: true,
        aeskey: aeskey.toString('hex'),
        base_info: baseInfo(),
      });
      const uploadRejection = rejectionOf(upload.parsed);
      if (uploadRejection) {
        log(`    getuploadurl REJECTED: ${uploadRejection}`);
        return { ok: false, detail: `getuploadurl ${uploadRejection}` };
      }
      const uploadUrl = resolveUploadUrl(upload.parsed, filekey);
      const cipher = createCipheriv('aes-128-ecb', aeskey, null);
      const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
      const cdn = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(ciphertext.length),
        },
        body: new Uint8Array(ciphertext),
      });
      if (cdn.status !== 200) {
        const message = cdn.headers.get('x-error-message') || (await cdn.text());
        log(`    CDN upload FAILED: ${message || cdn.status}`);
        return { ok: false, detail: `cdn ${cdn.status}` };
      }
      const downloadParam = cdn.headers.get('x-encrypted-param') || '';
      if (!downloadParam) return { ok: false, detail: 'cdn missing x-encrypted-param' };
      log(`    uploaded ${fileName} (${bytes.length} bytes, media_type ${mediaType})`);
      body = itemOf({
        media: {
          encrypt_query_param: downloadParam,
          aes_key: Buffer.from(aeskey.toString('hex')).toString('base64'),
          encrypt_type: 1,
        },
        ciphertextSize,
        fileName,
        byteLength: bytes.length,
      });
    }
    const result = await post('ilink/bot/sendmessage', body);
    const detail = JSON.stringify(result.parsed);
    log(`    sendmessage HTTP ${result.status} -> ${detail}`);
    const rejection = rejectionOf(result.parsed);
    if (rejection) return { ok: false, detail: rejection };
    return { ok: true, detail };
  } catch (error) {
    log(`    FAILED: ${error?.message || error}`);
    return { ok: false, detail: String(error?.message || error) };
  }
}

const envelope = (msg) => ({ msg, base_info: baseInfo() });
const textMsg = (text, contextToken) => envelope({
  from_user_id: '',
  to_user_id: OWNER,
  client_id: `cyberboss-e2e-${randomUUID()}`,
  message_type: 2,
  message_state: 2,
  item_list: [{ type: 1, text_item: { text } }],
  ...(contextToken ? { context_token: contextToken } : {}),
});
const mediaMsg = (item, contextToken) => envelope({
  from_user_id: '',
  to_user_id: OWNER,
  client_id: `cyberboss-e2e-${randomUUID()}`,
  message_type: 2,
  message_state: 2,
  item_list: [item],
  ...(contextToken ? { context_token: contextToken } : {}),
});

async function runMatrix(contextToken, inboundText) {
  log('');
  log('=========================================================');
  log(`INBOUND RECEIVED: ${JSON.stringify(inboundText).slice(0, 120)}`);
  log(`context_token: len=${contextToken.length} ${contextToken.slice(0, 20)}…`);
  log(`pacing: ${SEQUENTIAL ? `sequential, ${GAP_MS}ms gap` : 'back-to-back'}`);
  log('=========================================================');

  const pause = async () => {
    if (SEQUENTIAL) await new Promise((r) => setTimeout(r, GAP_MS));
  };

  const results = {};
  results['1 text (no token)'] = await attempt(
    '1/4 text WITHOUT context_token (expect ret -2)',
    () => textMsg('cyberboss e2e 1/4: text without context_token (expected to be rejected).', ''),
  );
  await pause();
  results['2 text (fresh token)'] = await attempt(
    '2/4 text WITH the fresh context_token (decisive)',
    () => textMsg('cyberboss e2e 2/4: text with the fresh context_token.', contextToken),
  );
  await pause();

  if (results['2 text (fresh token)'].ok && fileToSend) {
    results['3 file (media_type 3)'] = await attempt(
      `3/4 FILE send via media_type 3 -> type 4 (${basename(fileToSend)})`,
      () => null,
      {
        media: {
          filePath: fileToSend,
          mediaType: 3,
          itemOf: ({ media, fileName, byteLength }) => mediaMsg(
            { type: 4, file_item: { media, file_name: fileName, len: String(byteLength) } },
            contextToken,
          ),
        },
      },
    );
    await pause();
  } else if (!results['2 text (fresh token)'].ok) {
    log('3/4 SKIPPED — the token path already failed, so media cannot succeed either.');
  }

  if (results['2 text (fresh token)'].ok && videoToSend) {
    results['4 video (media_type 2)'] = await attempt(
      `4/4 NATIVE VIDEO send via media_type 2 -> type 5 (${basename(videoToSend)})`,
      () => null,
      {
        media: {
          filePath: videoToSend,
          mediaType: 2,
          itemOf: ({ media, ciphertextSize }) => mediaMsg(
            { type: 5, video_item: { media, video_size: ciphertextSize } },
            contextToken,
          ),
        },
      },
    );
  }

  log('');
  log('================= MATRIX RESULT =================');
  for (const [name, r] of Object.entries(results)) {
    log(`  ${name.padEnd(26)} ${r.ok ? 'ACCEPTED' : `rejected (${r.detail})`}`);
  }
  log('================================================');
  const decisive = results['2 text (fresh token)'].ok;
  log(decisive
    ? 'VERDICT: context_token is the only blocker — a fresh inbound token unlocks outbound sends.'
    : 'VERDICT: a fresh inbound token was NOT sufficient; the hypothesis is incomplete.');
  if (results['4 video (media_type 2)']) {
    log(results['4 video (media_type 2)'].ok
      ? 'VIDEO: the provider ACCEPTED media_type 2 / type 5 — check WeChat for a playable bubble.'
      : 'VIDEO: media_type 2 was rejected — compare with the file result above.');
  }
  return results;
}

// ---------------------------------------------------------------- main

log('=== weixin end-to-end self-test ===');
log(`owner: ${OWNER}`);
log(`token: ${token.slice(0, 12)}… (len ${token.length})`);
if (fileToSend) log(`file : ${fileToSend}`);
if (videoToSend) log(`video: ${videoToSend}`);

log('');
log('step 1: notifystart');
const start = await post('ilink/bot/msg/notifystart', { base_info: baseInfo() });
log(`  notifystart -> HTTP ${start.status} ${JSON.stringify(start.parsed)}`);

if (LIST_ONLY) {
  log('');
  log('step 2: one getupdates call (--list-only)');
  const poll = await post('ilink/bot/getupdates', { get_updates_buf: '', base_info: baseInfo() }, { timeoutMs: LONG_POLL_MS + 10_000 });
  log(`  getupdates -> HTTP ${poll.status}`);
  log(`  raw: ${JSON.stringify(poll.parsed).slice(0, 800)}`);
  log(`  ret=${poll.parsed?.ret} msgs=${Array.isArray(poll.parsed?.msgs) ? poll.parsed.msgs.length : 'n/a'}`);
  process.exit(0);
}

log('');
log(`>>> 请在微信里给 bot 发任意一条消息（例如「在吗」）— 我在自己长轮询，收到就立刻跑完整矩阵。<<<`);
log(`    (窗口 ${minutes} 分钟；我用自己的 sync 游标，不碰插件的 getUpdatesBuf)`);
log('');

// Two independent paths to the token, raced:
//   A. my own getupdates long-poll  — works even if the plugin is dead
//   B. the plugin's state.json      — works if the plugin consumed the message first
// Whichever produces a fresh token first wins; the other is abandoned.
const STATE = 'C:\\Users\\79388\\.dsh\\integrations\\dsh-weixin\\accounts\\wx_a245fd04968c7a4262b20a5d\\state.json';
function stateEntry() {
  try {
    const state = JSON.parse(readFileSync(STATE, 'utf8'));
    return state?.contextTokens?.users?.[OWNER] ?? null;
  } catch { return null; }
}
const baseline = stateEntry();
log(`baseline state.json: seq=${baseline?.seq} messageTimeMs=${baseline?.messageTimeMs}`);
log('');

const deadline = Date.now() + minutes * 60_000;
let inbound = null;

/** Path A: my own long-poll. */
async function pollForInbound() {
  let cursor = '';
  let polls = 0;
  let lastBeat = Date.now();
  while (Date.now() < deadline && !inbound) {
    let poll;
    try {
      poll = await post('ilink/bot/getupdates', {
        get_updates_buf: cursor,
        base_info: baseInfo(),
      }, { timeoutMs: LONG_POLL_MS + 15_000 });
    } catch (error) {
      log(`  [poll] error (${error?.message || error}); retrying`);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    polls += 1;
    // Liveness must be observable within seconds, not minutes: a silent hang is
    // otherwise indistinguishable from "still polling". Record every cycle.
    try {
      writeFileSync(POLL_MARKER, `${JSON.stringify({
        polls,
        at: new Date().toISOString(),
        windowLeftMinutes: Math.round((deadline - Date.now()) / 60_000),
      })}\n`);
    } catch { /* observability must never break the listener */ }
    // A heartbeat proves the long poll is actually cycling rather than hung.
    if (Date.now() - lastBeat > 10 * 60_000) {
      lastBeat = Date.now();
      const left = Math.round((deadline - Date.now()) / 60_000);
      log(`  [poll] alive: ${polls} polls so far, ${left} minute(s) left in window`);
    }
    const rejection = rejectionOf(poll.parsed);
    if (rejection) {
      log(`  [poll] REJECTED: ${rejection}`);
      if (rejection === 'ret=-14') {
        log('  [poll] ret=-14 = session expired; the bot must re-pair via QR. Stopping.');
        process.exit(2);
      }
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    if (typeof poll.parsed?.get_updates_buf === 'string' && poll.parsed.get_updates_buf) {
      cursor = poll.parsed.get_updates_buf;
    }
    const msgs = Array.isArray(poll.parsed?.msgs) ? poll.parsed.msgs : [];
    if (msgs.length === 0) continue;

    log(`  [poll] got ${msgs.length} message(s)`);
    for (const message of msgs) {
      log(`  [poll] keys: ${Object.keys(message).join(',')}`);
      log(`  [poll] raw: ${JSON.stringify(message).slice(0, 500)}`);
    }
    const withToken = msgs.find((m) => typeof m?.context_token === 'string' && m.context_token);
    if (!withToken) {
      log('  [poll] no context_token in that batch; continuing');
      continue;
    }
    if (!inbound) {
      log('  [poll] WON the race — token from my own long-poll');
      inbound = {
        token: withToken.context_token,
        text: withToken?.item_list?.[0]?.text_item?.text ?? '',
        via: 'getupdates',
      };
    }
    return;
  }
}

/** Path B: the plugin's persisted token. */
async function watchStateFile() {
  while (Date.now() < deadline && !inbound) {
    await new Promise((r) => setTimeout(r, 2500));
    const current = stateEntry();
    if (!current?.token) continue;
    const fresh = Number(current.messageTimeMs) > Number(baseline?.messageTimeMs ?? 0)
      || String(current.seq) !== String(baseline?.seq);
    if (!fresh) continue;
    if (!inbound) {
      log(`  [state] WON the race — plugin refreshed the token (seq ${baseline?.seq} -> ${current.seq})`);
      inbound = { token: current.token, text: '', via: 'state.json' };
    }
    return;
  }
}

await Promise.race([pollForInbound(), watchStateFile()]);

// Give a losing path a moment to notice `inbound` was set, then stop.
if (!inbound) {
  log('');
  log(`no inbound message within ${minutes} minute(s) — the matrix never ran.`);
  process.exit(3);
}
log(`token source: ${inbound.via}`);

const results = await runMatrix(inbound.token, inbound.text);
const decisiveOk = results['2 text (fresh token)'].ok;
process.exit(decisiveOk ? 0 : 1);
