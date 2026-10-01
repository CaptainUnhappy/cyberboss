#!/usr/bin/env node
/**
 * cdp-click-text.js - click any element whose text matches exactly, using real
 * input events (CDP Input.dispatchMouseEvent).
 * usage: node cdp-click-text.js <pageNeedle> <text> [--index N] [--exact]
 *
 * Why this exists: Quark's React widgets ignore element.click(); they need real
 * trusted input events, and many controls (filter chips, tree rows) are plain
 * DIV/SPAN/LI without ids - so locate by text and click at its centre.
 */
const HOST = process.env.CDP_HOST || '127.0.0.1';
const PORT = Number(process.env.CDP_PORT || 9222);
const [needle, want, ...rest] = process.argv.slice(2);
const idxFlag = rest.indexOf('--index');
const INDEX = idxFlag >= 0 ? Number(rest[idxFlag + 1]) : 0;
const EXACT = rest.includes('--exact');

(async () => {
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

  const box = await send('Runtime.evaluate', {
    expression: `(() => {
      const t = ${JSON.stringify(want)};
      const exact = ${EXACT ? 'true' : 'false'};
      const cands = Array.from(document.querySelectorAll('*')).filter((el) => {
        const own = (el.textContent || '').trim().replace(/\\s+/g, '');
        const target = t.replace(/\\s+/g, '');
        if (!own) return false;
        if (exact ? own !== target : own.indexOf(target) < 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 4 && r.height > 4;
      });
      if (!cands.length) return null;
      cands.sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        return ra.width * ra.height - rb.width * rb.height;
      });
      const el = cands[Math.min(${INDEX}, cands.length - 1)];
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return JSON.stringify({ tag: el.tagName, cls: String(el.className || '').slice(0, 50),
                              text: (el.innerText || '').trim().slice(0, 30), candidates: cands.length,
                              cx: r.left + r.width / 2, cy: r.top + r.height / 2,
                              rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] });
    })()`,
    returnByValue: true,
  });
  const val = box.result && box.result.result ? box.result.result.value : null;
  if (!val) { console.log(JSON.stringify({ ok: false, reason: 'no element with text: ' + want })); ws.close(); return; }
  const t = JSON.parse(val);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: t.cx, y: t.cy, button: 'none', buttons: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: t.cx, y: t.cy, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: t.cx, y: t.cy, button: 'left', buttons: 0, clickCount: 1 });
  await new Promise((r) => setTimeout(r, 2000));
  console.log(JSON.stringify({ ok: true, clicked: t }, null, 1));
  ws.close();
})().catch((e) => { console.error('ERROR ' + e.message); process.exit(1); });
