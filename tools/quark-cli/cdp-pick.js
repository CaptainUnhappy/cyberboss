#!/usr/bin/env node
/**
 * cdp-pick.js - click a row by its visible text using real input events,
 * then report the accessible selection state.
 * usage: node cdp-pick.js <urlSubstr> <textSubstr>
 */
const HOST = process.env.CDP_HOST || '127.0.0.1';
const PORT = Number(process.env.CDP_PORT || 9222);
const [needle, want] = process.argv.slice(2);
const norm = (s) =>
  Array.from(s || '')
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 0x4e00 && c <= 0x9fff);
    })
    .join('');
const WANT_NORM = norm(want);
console.log('# needle=' + JSON.stringify(needle) + '  want=' + JSON.stringify(want) +
            '  normalized=' + JSON.stringify(WANT_NORM));

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
  await new Promise((r) => setTimeout(r, 400));

  const box = await send('Runtime.evaluate', {
    expression: `(() => {
      // normalise hard: strip whitespace, zero-width chars and full/half width
      // punctuation so a query like "夸克网盘免费领" matches regardless of how
      // the list splits or decorates the label.
      // No escapes whatsoever in this expression: the query is normalised on the
      // Node side and injected as a plain string; the page only filters code points.
      const keep = (ch) => {
        const c = ch.charCodeAt(0);
        return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 0x4e00 && c <= 0x9fff);
      };
      const norm = (s) => Array.from(s || '').filter(keep).join('');
      const want = ${JSON.stringify(WANT_NORM)};
      const items = Array.from(document.querySelectorAll(
        '.auto-size-list-item, [class*="ColumnsFile__file-item"], [class*="file-click-wrap"], tr.ant-table-row'));
      const cands = items.filter((el) => norm(el.textContent).includes(want));
      if (!cands.length) {
        const sample = items.slice(0, 6).map((el) => norm(el.textContent).slice(0, 70));
        return JSON.stringify({ miss: true, itemsSeen: items.length, want: want, sample });
      }
      // fewest characters = the tightest element around the match
      cands.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
      const hit = cands[0];
      hit.scrollIntoView({ block: 'center' });
      const r = hit.getBoundingClientRect();
      return JSON.stringify({ tag: hit.tagName, cls: String(hit.className || '').slice(0, 50),
                              text: (hit.textContent || '').trim().slice(0, 60),
                              matched: cands.length,
                              rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
                              cx: r.left + r.width / 2, cy: r.top + r.height / 2 });
    })()`,
    returnByValue: true,
  });
  const info = box.result && box.result.result ? box.result.result.value : null;
  if (!info) { console.log(JSON.stringify({ ok: false, reason: 'row not found' })); ws.close(); return; }
  const t = JSON.parse(info);

  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: t.cx, y: t.cy, button: 'none', buttons: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: t.cx, y: t.cy, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: t.cx, y: t.cy, button: 'left', buttons: 0, clickCount: 1 });
  await new Promise((r) => setTimeout(r, 1500));

  // selection evidence: AX names that mention 已选 / 项, plus class hints
  await send('Accessibility.enable');
  const ax = (await send('Accessibility.getFullAXTree')).result.nodes;
  const selNames = ax.filter((nd) => nd.name && /已选|项$|选择/.test(String(nd.name.value)) && !nd.ignored)
                      .map((nd) => `${(nd.role && nd.role.value) || '?'}: ${String(nd.name.value).slice(0, 40)}`);
  const cls = await send('Runtime.evaluate', {
    expression: `(() => {
      const sel = [];
      document.querySelectorAll('[class*="selected"], [class*="active"], [class*="checked"]').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 4) sel.push(String(el.className).slice(0, 60) + ' @' + Math.round(r.left) + ',' + Math.round(r.top));
      });
      return JSON.stringify(sel.slice(0, 8));
    })()`,
    returnByValue: true,
  });

  console.log(JSON.stringify({ ok: true, clicked: t, axSelection: selNames.slice(0, 8),
                               classHints: JSON.parse(cls.result.result.value) }, null, 1));
  ws.close();
})().catch((e) => { console.error('ERROR ' + e.message); process.exit(1); });
