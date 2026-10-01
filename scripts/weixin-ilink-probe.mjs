// End-to-end probe of the official WeChat (iLink) bot channel.
//
// Sends a message straight to the provider with the bot token from the DSH
// credential store, without going through the dsh-im plugin or an agent turn.
// This exists to answer one question the GUI path cannot: does the provider
// accept a *proactively composed* outbound message, and does it need a
// context_token to do it?
//
// Usage:
//   node weixin-probe.mjs text  [--message "..." ] [--with-token]
//   node weixin-probe.mjs file   <path> [--with-token]
//   node weixin-probe.mjs video  <path> [--with-token]
import { createHash, randomBytes, randomUUID, createCipheriv } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

const CREDENTIALS = 'C:\\Users\\79388\\.dsh\\.credentials.yaml';
const REF = 'DSH_WEIXIN_BOT_TOKEN_A245FD04968C7A4262B20A5D';
const BASE_URL = 'https://ilinkai.weixin.qq.com/';
const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';
const TO_USER = 'o9cq801fW13sRZ4HDX4FqKb3lHDs@im.wechat';

const PROTOCOL_VERSION = '2.4.6';
const APP_ID = 'bot';
const CLIENT_VERSION = (2 << 16) | (4 << 8) | 6;

function readToken() {
  const raw = readFileSync(CREDENTIALS, 'utf8');
  const line = raw.split(/\r?\n/).find((l) => l.trim().startsWith(`${REF}:`));
  if (!line) throw new Error(`credential ${REF} not found`);
  const value = line.slice(line.indexOf(':') + 1).trim().replace(/^["']|["']$/g, '');
  if (!value) throw new Error(`credential ${REF} is empty`);
  return value;
}

function headers(token) {
  return {
    'iLink-App-Id': APP_ID,
    'iLink-App-ClientVersion': String(CLIENT_VERSION),
    'content-type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    Authorization: `Bearer ${token}`,
    'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64'),
  };
}

function baseInfo() {
  return { channel_version: PROTOCOL_VERSION, bot_agent: 'DeepSeekHarness/1.1.0' };
}

async function post(endpoint, token, body) {
  const response = await fetch(new URL(endpoint, BASE_URL), {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* non-JSON error page */ }
  return { status: response.status, parsed, text };
}

function rejectionOf(parsed) {
  if (!parsed || typeof parsed !== 'object') return '';
  for (const key of ['errcode', 'ret', 'code']) {
    const value = parsed[key];
    if (typeof value === 'number' && value !== 0) return `${key}=${value}`;
  }
  return '';
}

function aesEcbPaddedSize(size) {
  return Math.ceil((size + 1) / 16) * 16;
}

async function uploadToCdn(buf, url, aeskey) {
  const cipher = createCipheriv('aes-128-ecb', aeskey, null);
  const ciphertext = Buffer.concat([cipher.update(buf), cipher.final()]);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(ciphertext.length),
    },
    body: new Uint8Array(ciphertext),
  });
  if (response.status !== 200) {
    const message = response.headers.get('x-error-message') || await response.text();
    throw new Error(`CDN upload failed: ${message || response.status}`);
  }
  const downloadParam = response.headers.get('x-encrypted-param') || '';
  if (!downloadParam) throw new Error('CDN upload response missing x-encrypted-param');
  return downloadParam;
}

// Mirrors weixin-api.mjs `weixinCdnUploadUrl`: prefer the provider's full URL,
// fall back to composing one from upload_param, and trust-check the result.
function resolveUploadUrl(response, fileKey) {
  const fullUrl = typeof response?.upload_full_url === 'string' ? response.upload_full_url.trim() : '';
  const uploadParam = typeof response?.upload_param === 'string' ? response.upload_param.trim() : '';
  const url = fullUrl
    ? new URL(fullUrl)
    : (() => {
      if (!uploadParam) throw new Error('getuploadurl returned neither upload_full_url nor upload_param');
      const composed = new URL(`${CDN_BASE}/upload`);
      composed.searchParams.set('encrypted_query_param', uploadParam);
      composed.searchParams.set('filekey', fileKey);
      return composed;
    })();
  const trusted = url.protocol === 'https:'
    && url.hostname === 'novac2c.cdn.weixin.qq.com'
    && (!url.port || url.port === '443')
    && url.pathname === '/c2c/upload'
    && !url.username && !url.password;
  if (!trusted) throw new Error(`untrusted upload url: ${url.origin}${url.pathname}`);
  url.hash = '';
  return { url, source: fullUrl ? 'upload_full_url' : 'upload_param' };
}

async function sendMedia(token, filePath, { mediaType, itemOf }) {
  const bytes = readFileSync(filePath);
  const fileName = basename(filePath);
  const filekey = randomBytes(16).toString('hex');
  const aeskey = randomBytes(16);
  const rawMd5 = createHash('md5').update(bytes).digest('hex');
  const ciphertextSize = aesEcbPaddedSize(bytes.length);

  console.log(`  file       : ${fileName} (${bytes.length} bytes)`);
  console.log(`  media_type : ${mediaType}`);
  console.log(`  rawfilemd5 : ${rawMd5}`);

  const upload = await post('ilink/bot/getuploadurl', token, {
    filekey,
    media_type: mediaType,
    to_user_id: TO_USER,
    rawsize: bytes.length,
    rawfilemd5: rawMd5,
    filesize: ciphertextSize,
    no_need_thumb: true,
    aeskey: aeskey.toString('hex'),
    base_info: baseInfo(),
  });
  console.log(`  getuploadurl -> HTTP ${upload.status} ${JSON.stringify(upload.parsed)}`);
  const rejection = rejectionOf(upload.parsed);
  if (rejection) throw new Error(`getuploadurl rejected: ${rejection}`);

  const { url: uploadUrl } = resolveUploadUrl(upload.parsed, filekey);

  const downloadParam = await uploadToCdn(bytes, uploadUrl, aeskey);
  console.log(`  cdn upload -> ok`);

  const media = {
    encrypt_query_param: downloadParam,
    aes_key: Buffer.from(aeskey.toString('hex')).toString('base64'),
    encrypt_type: 1,
  };

  const result = await post('ilink/bot/sendmessage', token, {
    msg: {
      from_user_id: '',
      to_user_id: TO_USER,
      client_id: `cyberboss-probe-${randomUUID()}`,
      message_type: 2,
      message_state: 2,
      item_list: [itemOf({ media, ciphertextSize, fileName, byteLength: bytes.length })],
    },
    base_info: baseInfo(),
  });
  return result;
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  const withToken = rest.includes('--with-token');
  const positional = rest.filter((a) => !a.startsWith('--'));
  const messageIndex = rest.indexOf('--message');
  const message = messageIndex >= 0 ? rest[messageIndex + 1] : '';
  const token = readToken();

  console.log(`mode=${mode}  context_token=${withToken ? 'INCLUDED (stale, from state.json)' : 'omitted'}`);
  console.log(`token: ${token.slice(0, 12)}…${token.slice(-4)} (len ${token.length})\n`);

  let contextToken = '';
  if (withToken) {
    const state = JSON.parse(readFileSync(
      'C:\\Users\\79388\\.dsh\\integrations\\dsh-weixin\\accounts\\wx_a245fd04968c7a4262b20a5d\\state.json',
      'utf8',
    ));
    contextToken = state?.contextTokens?.users?.[TO_USER]?.token ?? '';
    console.log(`stored contextToken seq=${state?.contextTokens?.users?.[TO_USER]?.seq} len=${contextToken.length}\n`);
  }

  if (mode === 'notify') {
    const start = await post('ilink/bot/msg/notifystart', token, { base_info: baseInfo() });
    console.log(`notifystart -> HTTP ${start.status} ${JSON.stringify(start.parsed)}`);
    const startRejection = rejectionOf(start.parsed);
    if (startRejection) {
      console.log(startRejection === 'ret=-14'
        ? '\nVERDICT: ret=-14 => the bot token is STALE. Re-login (QR) is required.'
        : `\nVERDICT: notifystart rejected (${startRejection})`);
    } else {
      console.log('\nVERDICT: bot session started');
    }
    process.exit(startRejection ? 1 : 0);
  }

  if (mode === 'poll') {
    const result = await post('ilink/bot/getupdates', token, {
      get_updates_buf: '',
      base_info: baseInfo(),
    });
    console.log(`getupdates -> HTTP ${result.status}`);
    console.log(`response   : ${JSON.stringify(result.parsed).slice(0, 600)}`);
    const rejection = rejectionOf(result.parsed);
    const msgs = Array.isArray(result.parsed?.msgs) ? result.parsed.msgs.length : null;
    console.log(`\nret=${result.parsed?.ret} errmsg=${result.parsed?.errmsg ?? '(none)'} msgs=${msgs}`);
    console.log(rejection
      ? 'VERDICT: bot connection is NOT accepting updates'
      : 'VERDICT: bot connection is live');
    process.exit(0);
  }

  if (mode === 'upload') {
    // Does the media upload handshake need a context_token? `sendmessage`
    // certainly does, but getuploadurl + CDN upload may not, and separating the
    // two tells us how much of the media path can be proven without a window.
    const filePath = positional[0];
    if (!filePath) throw new Error('upload mode needs a path');
    const mediaType = Number(rest[rest.indexOf('--media-type') + 1]) || 2;
    statSync(filePath);
    const bytes = readFileSync(filePath);
    const filekey = randomBytes(16).toString('hex');
    const aeskey = randomBytes(16);
    const rawMd5 = createHash('md5').update(bytes).digest('hex');
    const ciphertextSize = aesEcbPaddedSize(bytes.length);
    console.log(`  file       : ${basename(filePath)} (${bytes.length} bytes)`);
    console.log(`  media_type : ${mediaType}`);
    const upload = await post('ilink/bot/getuploadurl', token, {
      filekey,
      media_type: mediaType,
      to_user_id: TO_USER,
      rawsize: bytes.length,
      rawfilemd5: rawMd5,
      filesize: ciphertextSize,
      no_need_thumb: true,
      aeskey: aeskey.toString('hex'),
      base_info: baseInfo(),
    });
    console.log(`getuploadurl -> HTTP ${upload.status} ${JSON.stringify(upload.parsed)}`);
    const rejection = rejectionOf(upload.parsed);
    if (rejection) {
      console.log(`\nREJECTED at getuploadurl: ${rejection}`);
      process.exit(1);
    }
    const { url: uploadUrl, source } = resolveUploadUrl(upload.parsed, filekey);
    console.log(`  url source : ${source}`);
    const downloadParam = await uploadToCdn(bytes, uploadUrl, aeskey);
    console.log(`CDN upload  -> OK (downloadParam len ${downloadParam.length})`);
    console.log('\nVERDICT: the media upload half does NOT need a context_token.');
    console.log('         Only the final sendmessage step does.');
    process.exit(0);
  }

  if (mode === 'order') {
    // Which check runs first on the server: the context_token or the item shape?
    // Sending a deliberately empty text item separates the two. If the server
    // still answers "prepare failed", the token is validated first (so the item
    // shape was never examined). A different errmsg means the shape was checked.
    const variants = [
      ['empty text_item', { type: 1, text_item: { text: '' } }],
      ['null-ish item', { type: 1 }],
      ['text without item_list', null],
    ];
    for (const [label, item] of variants) {
      const msg = {
        from_user_id: '',
        to_user_id: TO_USER,
        client_id: `cyberboss-order-${randomUUID()}`,
        message_type: 2,
        message_state: 2,
        ...(item ? { item_list: [item] } : {}),
      };
      const result = await post('ilink/bot/sendmessage', { msg, base_info: baseInfo() });
      console.log(`${label.padEnd(24)} -> HTTP ${result.status} ${JSON.stringify(result.parsed)}`);
    }
    console.log('\nInterpretation: if every variant returns the SAME errmsg, that check runs');
    console.log('before item-shape validation, so these probes say nothing about item shape.');
    process.exit(0);
  }

  if (mode === 'text') {
    const runIdIndex = rest.indexOf('--run-id');
    const runId = runIdIndex >= 0 ? rest[runIdIndex + 1] : '';
    const body = {
      msg: {
        from_user_id: '',
        to_user_id: TO_USER,
        client_id: `cyberboss-probe-${randomUUID()}`,
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text: message || 'cyberboss probe: text delivery test' } }],
        ...(contextToken ? { context_token: contextToken } : {}),
        ...(runId ? { run_id: runId } : {}),
      },
      base_info: baseInfo(),
    };
    const result = await post('ilink/bot/sendmessage', token, body);
    console.log(`sendmessage -> HTTP ${result.status}`);
    console.log(`response   : ${JSON.stringify(result.parsed)}`);
    const rejection = rejectionOf(result.parsed);
    console.log(rejection ? `\nREJECTED: ${rejection}` : '\nACCEPTED by provider');
    process.exit(rejection ? 1 : 0);
  }

  if (mode === 'file') {
    const filePath = positional[0];
    if (!filePath) throw new Error('file mode needs a path');
    statSync(filePath);
    const result = await sendMedia(token, filePath, {
      mediaType: 3,
      itemOf: ({ media, fileName, byteLength }) => ({
        type: 4,
        file_item: { media, file_name: fileName, len: String(byteLength) },
      }),
    });
    console.log(`sendmessage -> HTTP ${result.status} ${JSON.stringify(result.parsed)}`);
    const rejection = rejectionOf(result.parsed);
    console.log(rejection ? `\nREJECTED: ${rejection}` : '\nACCEPTED by provider');
    process.exit(rejection ? 1 : 0);
  }

  if (mode === 'video') {
    const filePath = positional[0];
    if (!filePath) throw new Error('video mode needs a path');
    statSync(filePath);
    const result = await sendMedia(token, filePath, {
      mediaType: 2,
      itemOf: ({ media, ciphertextSize }) => ({
        type: 5,
        video_item: { media, video_size: ciphertextSize },
      }),
    });
    console.log(`sendmessage -> HTTP ${result.status} ${JSON.stringify(result.parsed)}`);
    const rejection = rejectionOf(result.parsed);
    console.log(rejection ? `\nREJECTED: ${rejection}` : '\nACCEPTED by provider');
    process.exit(rejection ? 1 : 0);
  }

  throw new Error(`unknown mode: ${mode}`);
}

main().catch((error) => {
  console.error(`\nFAILED: ${error?.message || error}`);
  process.exit(1);
});
