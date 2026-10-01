#!/usr/bin/env node
/**
 * cdp-click-text2.js - click the tightest element whose own text equals/contains
 * a label, using real input events. Matching happens in Node (see
 * cdp-click-row.js for why the page-side expression stays trivial).
 *
 * usage: node cdp-click-text2.js <pageNeedle> <label> [--contains] [--index N]
 */
const HOST = process.env.CDP_HOST || '127.0.0.1';
const PORT = Number(process.env.CDP_PORT || 9222);
const [needle, label, ...rest] = process.argv.slice(2);
const CONTAINS = rest.includes('--contains');
const idxFlag = rest.indexOf('--index');
const INDEX = idxFlag >= 0 ? Number(rest[idxFlag + 1]) : 0;

const norm = (s) =>
  Array.from(s || '')
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 0x4e00 && c <= 0x9fff);
    })
    .join('');

const LABEL = norm(label);
console.log(`# label="${label}" normalised="${LABEL}" contains=${CONTAINS}`);

async function main() {
  const list = await (await fetch(`http://${HOST}:${PORT}/json`)).json();
  const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const page = pages.find((p) => (p.url || '').includes(needle) || (p.title || '').includes(needle));
  if (!page) throw new Error('no page for ' + needle);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let id = 0;
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  const send = (method, params = {}) => new Promise((res, rej) => {
    const myId = ++id;
    pending.set(myId, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
  await send('Runtime.enable');
  await new Promise((r) => setTimeout(r, 300));

  const collect = `JSON.stringify(Array.from(document.querySelectorAll('button, [role=button], a, span, div, li, svg, i')).map(function (el) {
      var r = el.getBoundingClientRect();
      return { t: (el.innerText || el.textContent || '').trim(), ti: el.getAttribute ? (el.getAttribute('title') || el.getAttribute('aria-label') || '') : '', x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), c: String(el.className || '').slice(0, 40), dis: el.disabled === true };
    }))`;
  const res = await send('Runtime.evaluate', { expression: collect, returnByValue: true });
  if (res.exceptionDetails) throw new Error('page exception');
  const items = JSON.parse(res.result && res.result.value ? res.result.value : '[]')
    .filter((it) => it.w > 4 && it.h > 4);

  const matches = items.filter((it) => {
    const own = norm(it.t);
    const ttl = norm(it.ti);
    if (CONTAINS) return own.includes(LABEL) || ttl.includes(LABEL);
    return own === LABEL || ttl === LABEL;
  });
  if (!matches.length) {
    console.log(JSON.stringify({ ok: false, reason: 'no element with label', label }, null, 1));
    ws.close();
    return;
  }
  matches.sort((a, b) => (a.t.length - b.t.length) || (a.w * a.h - b.w * b.h));
  const hit = matches[Math.min(INDEX, matches.length - 1)];
  const cx = hit.x + hit.w / 2;
  const cy = hit.y + hit.h / 2;
  console.log(`# target: ${hit.c} [${hit.x},${hit.y} ${hit.w}x${hit.h}] text="${hit.t}" disabled=${hit.dis} of ${matches.length}`);

  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, button: 'none', buttons: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', buttons: 0, clickCount: 1 });
  await new Promise((r) => setTimeout(r, 2500));
  console.log(JSON.stringify({ ok: true, clicked: { label, x: cx, y: cy, cls: hit.c, disabled: hit.dis } }, null, 1));
  ws.close();
}

main().catch((e) => { console.error('ERROR ' + e.message); process.exit(1); });
