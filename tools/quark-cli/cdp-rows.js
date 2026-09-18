#!/usr/bin/env node
/**
 * cdp-rows.js - dump every row of the share dialog with name/size/type hints.
 * usage: node cdp-rows.js [limit]
 */
const HOST = process.env.CDP_HOST || '127.0.0.1';
const PORT = Number(process.env.CDP_PORT || 9222);
const limit = Number(process.argv[2] || 80);

(async () => {
  const list = await (await fetch(`http://${HOST}:${PORT}/json`)).json();
  const page = list.find((t) => (t.url || '').includes('share-link-window'));
  if (!page) throw new Error('share window not found');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let id = 0;
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  const send = (method, params = {}) => new Promise((res) => {
    const myId = ++id;
    pending.set(myId, res);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
  await send('Runtime.enable');
  await new Promise((r) => setTimeout(r, 400));

  const expr = `(() => {
    const text = (el) => (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
    const out = [];
    document.querySelectorAll('tr.ant-table-row').forEach((tr, i) => {
      const cells = Array.from(tr.querySelectorAll('td')).map((td) => text(td));
      const cb = tr.querySelector('input.ant-checkbox-input');
      out.push({ i: i, name: cells[1] || '', size: cells[2] || '', mtime: cells[3] || '',
                 checked: cb ? cb.checked : null });
    });
    const crumb = document.querySelector('[class*="breadcrumbs"]');
    return JSON.stringify({ count: out.length, breadcrumb: crumb ? text(crumb) : null, rows: out });
  })()`;
  const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  const val = res.result && res.result.result ? res.result.result.value : null;
  if (!val) { console.log(JSON.stringify({ ok: false })); ws.close(); return; }
  const data = JSON.parse(val);
  console.log('breadcrumb: ' + data.breadcrumb + '  rows: ' + data.count);
  for (const r of data.rows.slice(0, limit)) {
    console.log(`${r.i}\t${r.checked ? '[x]' : '[ ]'}\t${r.size}\t${r.name}`);
  }
  ws.close();
})().catch((e) => { console.error('ERROR ' + e.message); process.exit(1); });
