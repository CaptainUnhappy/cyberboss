#!/usr/bin/env node
/**
 * cdp-click-row.js - click a list row by text, using real input events.
 *
 * Design note: the page-side expression is deliberately trivial (it only returns
 * raw {text, rect} pairs). All normalisation and matching happens here in Node,
 * because injecting anything with regex/unicode escapes into the page silently
 * breaks the whole expression (CDP then reports no result, which looks like
 * "row not found").
 *
 * usage: node cdp-click-row.js <pageNeedle> <text> [--index N]
 */
const HOST = process.env.CDP_HOST || '127.0.0.1';
const PORT = Number(process.env.CDP_PORT || 9222);
const [needle, want, ...rest] = process.argv.slice(2);
const idxFlag = rest.indexOf('--index');
const INDEX = idxFlag >= 0 ? Number(rest[idxFlag + 1]) : 0;

const norm = (s) =>
  Array.from(s || '')
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 0x4e00 && c <= 0x9fff);
    })
    .join('');

const WANT = norm(want);
console.log(`# want="${want}" normalised="${WANT}"`);

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

  // trivial page-side collection
  const collect = `JSON.stringify(Array.from(document.querySelectorAll('.auto-size-list-item, [class*="ColumnsFile__file-item"], [class*="file-click-wrap"], tr.ant-table-row')).map(function (el) {
      var r = el.getBoundingClientRect();
      return { t: el.textContent || '', x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), c: String(el.className || '').slice(0, 40) };
    }))`;
  const res = await send('Runtime.evaluate', { expression: collect, returnByValue: true });
  if (res.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(res.exceptionDetails.exception || {}));
  const raw = res.result && res.result.value ? res.result.value : '[]';
  const items = JSON.parse(raw).filter((it) => it.w > 4 && it.h > 4);
  console.log(`# collected ${items.length} candidate elements`);

  const matches = items.filter((it) => norm(it.t).includes(WANT));
  if (!matches.length) {
    console.log(JSON.stringify({ ok: false, reason: 'no element matches', sample: items.slice(0, 5).map((i) => norm(i.t).slice(0, 50)) }, null, 1));
    ws.close();
    return;
  }
  // tightest match first (shortest text), then smallest area
  matches.sort((a, b) => (a.t.length - b.t.length) || (a.w * a.h - b.w * b.h));
  const hit = matches[Math.min(INDEX, matches.length - 1)];
  const cx = hit.x + hit.w / 2;
  const cy = hit.y + hit.h / 2;
  console.log(`# click target: ${hit.c} [${hit.x},${hit.y} ${hit.w}x${hit.h}] text="${hit.t.trim().slice(0, 50)}" of ${matches.length} matches`);

  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, button: 'none', buttons: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', buttons: 0, clickCount: 1 });
  await new Promise((r) => setTimeout(r, 1500));

  // selection evidence: element classes that look selected
  const selRes = await send('Runtime.evaluate', {
    expression: `JSON.stringify(Array.from(document.querySelectorAll('[class*="selected"], [class*="active"], [class*="checked"]')).filter(function (el) { var r = el.getBoundingClientRect(); return r.width > 4; }).map(function (el) { return String(el.className).slice(0, 60) + ' @' + Math.round(el.getBoundingClientRect().left) + ',' + Math.round(el.getBoundingClientRect().top); }).slice(0, 8))`,
    returnByValue: true,
  });
  const hints = selRes.result && selRes.result.value ? JSON.parse(selRes.result.value) : [];
  console.log(JSON.stringify({ ok: true, clicked: { x: cx, y: cy, cls: hit.c, text: hit.t.trim().slice(0, 60) }, selectionHints: hints }, null, 1));
  ws.close();
}

main().catch((e) => { console.error('ERROR ' + e.message); process.exit(1); });
