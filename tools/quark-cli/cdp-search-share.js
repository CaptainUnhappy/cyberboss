#!/usr/bin/env node
/**
 * cdp-search-share.js - type a query into the share dialog's search box and dump results.
 * usage: node cdp-search-share.js <query>
 */
const HOST = process.env.CDP_HOST || '127.0.0.1';
const PORT = Number(process.env.CDP_PORT || 9222);
const query = process.argv[2] || 'pdf';

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
  await new Promise((r) => setTimeout(r, 300));

  // focus the search input and type the query as real key events
  const box = await send('Runtime.evaluate', {
    expression: `(() => {
      const input = document.querySelector('input.ant-input');
      if (!input) return null;
      const r = input.getBoundingClientRect();
      input.focus();
      return JSON.stringify({ cx: r.left + r.width / 2, cy: r.top + r.height / 2,
                              placeholder: input.placeholder || '' });
    })()`,
    returnByValue: true,
  });
  const info = box.result && box.result.result ? box.result.result.value : null;
  if (!info) { console.log(JSON.stringify({ ok: false, reason: 'no search input' })); ws.close(); return; }
  const t = JSON.parse(info);
  // click into the field, verify it really has focus, then type slowly
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: t.cx, y: t.cy, button: 'none', buttons: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: t.cx, y: t.cy, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: t.cx, y: t.cy, button: 'left', buttons: 0, clickCount: 1 });
  await new Promise((r) => setTimeout(r, 400));
  const focused = await send('Runtime.evaluate', {
    expression: `(() => { const i = document.querySelector('input.ant-input'); return i ? JSON.stringify({ hasFocus: document.hasFocus(), active: document.activeElement === i }) : null; })()`,
    returnByValue: true,
  });
  const focusState = focused.result && focused.result.result ? focused.result.result.value : null;
  console.log('# field focus: ' + focusState);
  // clear the field first (select-all + delete), then type one event per char.
  // NOTE: sending both keyDown(text) and char duplicates every character
  // (observed "pdf" -> "pdfppddff"), so only keyDown(text) is used.
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await new Promise((r) => setTimeout(r, 300));
  for (const ch of query) {
    const vk = ch.toUpperCase().charCodeAt(0);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch, windowsVirtualKeyCode: vk });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, windowsVirtualKeyCode: vk });
    await new Promise((r) => setTimeout(r, 150));
  }
  await new Promise((r) => setTimeout(r, 600));
  // commit the query: this component needs Enter (typing alone does not filter)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await new Promise((r) => setTimeout(r, 2500));
  const typed = await send('Runtime.evaluate', {
    expression: `(() => { const i = document.querySelector('input.ant-input'); return i ? i.value : '(none)'; })()`,
    returnByValue: true,
  });
  console.log('# field value now: ' + (typed.result && typed.result.result ? typed.result.result.value : '?'));

  const res = await send('Runtime.evaluate', {
    expression: `(() => {
      const text = (el) => (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
      const rows = [];
      document.querySelectorAll('tr.ant-table-row').forEach((tr, i) => {
        const cells = Array.from(tr.querySelectorAll('td')).map((td) => text(td));
        const cb = tr.querySelector('input.ant-checkbox-input');
        rows.push({ i, name: cells[1] || '', size: cells[2] || '', checked: cb ? cb.checked : null });
      });
      const crumb = document.querySelector('[class*="breadcrumbs"]');
      const empty = document.querySelector('[class*="empty"]');
      return JSON.stringify({ breadcrumb: crumb ? text(crumb) : null,
                              emptyText: empty ? text(empty).slice(0, 60) : null,
                              count: rows.length, rows });
    })()`,
    returnByValue: true,
  });
  const out = res.result && res.result.result ? res.result.result.value : null;
  console.log('query: ' + query);
  if (out) {
    const d = JSON.parse(out);
    console.log('breadcrumb: ' + d.breadcrumb + (d.emptyText ? '  empty="' + d.emptyText + '"' : '') + '  rows: ' + d.count);
    for (const r of d.rows) console.log(`${r.i}\t${r.checked ? '[x]' : '[ ]'}\t${r.size}\t${r.name}`);
  } else {
    console.log('(no result payload)');
  }
  ws.close();
})().catch((e) => { console.error('ERROR ' + e.message); process.exit(1); });
