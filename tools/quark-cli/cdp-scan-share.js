#!/usr/bin/env node
/**
 * cdp-scan-share.js - walk a share link's folders and report where PDFs live.
 * usage: node cdp-scan-share.js [--max N] [--ext .pdf]
 * Strategy: go back to the share root via the breadcrumb's first crumb, then
 * enter each top-level folder in turn and list its rows looking for the target
 * extension. Prints a table; stops early when --max hits are found.
 */
const HOST = process.env.CDP_HOST || '127.0.0.1';
const PORT = Number(process.env.CDP_PORT || 9222);
const argv = process.argv.slice(2);
const maxIdx = argv.indexOf('--max');
const MAX = maxIdx >= 0 ? Number(argv[maxIdx + 1]) : 3;
const extIdx = argv.indexOf('--ext');
const EXT = (extIdx >= 0 ? argv[extIdx + 1] : '.pdf').toLowerCase();

async function connect() {
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
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, userGesture: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error('page exception');
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const clickAt = async (x, y, double) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    for (const c of double ? [1, 2] : [1]) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: c });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: c });
      await new Promise((r) => setTimeout(r, 60));
    }
  };
  return { ws, evalJs, clickAt };
}

const ROWS_JS = `(() => {
  const text = (el) => (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
  const rows = [];
  document.querySelectorAll('tr.ant-table-row').forEach((tr, i) => {
    const cells = Array.from(tr.querySelectorAll('td')).map((td) => text(td));
    rows.push({ i, name: cells[1] || '', size: cells[2] || '' });
  });
  const crumb = document.querySelector('[class*="breadcrumbs"]');
  return JSON.stringify({ breadcrumb: crumb ? text(crumb) : null, rows });
})()`;

(async () => {
  const { ws, evalJs, clickAt } = await connect();

  // go back to the share root: click the first breadcrumb crumb (全部文件)
  const rootBox = await evalJs(`(() => {
    const el = document.querySelector('[class*="share-breadcrumbs-root"]') ||
               document.querySelector('[class*="breadcrumbs"] span');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return JSON.stringify({ cx: r.left + r.width / 2, cy: r.top + r.height / 2, text: (el.innerText || '').trim() });
  })()`);
  if (rootBox) {
    const rb = JSON.parse(rootBox);
    await clickAt(rb.cx, rb.cy, false);
    await new Promise((r) => setTimeout(r, 2000));
    console.log('# back to root via crumb "' + rb.text + '"');
  }

  const root = JSON.parse(await evalJs(ROWS_JS));
  console.log('# root: ' + root.breadcrumb + '  folders: ' + root.rows.length);

  const hits = [];
  for (const folder of root.rows) {
    const name = folder.name.replace(/\s+\d+项.*$/, '').trim();
    // enter the folder
    const box = await evalJs(`(() => {
      const text = (el) => (el.innerText || el.textContent || '').trim();
      const tr = Array.from(document.querySelectorAll('tr.ant-table-row'))
        .find((el) => text(el).includes(${JSON.stringify(name.slice(0, 12))}));
      if (!tr) return null;
      const cell = tr.querySelector('td.share-td-file') || tr;
      const r = cell.getBoundingClientRect();
      return JSON.stringify({ cx: r.left + r.width / 2, cy: r.top + r.height / 2 });
    })()`);
    if (!box) { console.log('?? cannot locate folder row: ' + name); continue; }
    const b = JSON.parse(box);
    await clickAt(b.cx, b.cy, true);
    await new Promise((r) => setTimeout(r, 1800));
    const inside = JSON.parse(await evalJs(ROWS_JS));
    const pdfs = inside.rows.filter((r) => r.name.toLowerCase().includes(EXT));
    console.log(`${pdfs.length ? 'HIT ' : '    '}${name}  -> ${inside.rows.length} 项` +
                (pdfs.length ? '  匹配: ' + pdfs.map((p) => p.name + ' (' + p.size + ')').join(' | ') : ''));
    for (const p of pdfs) hits.push({ folder: name, file: p.name, size: p.size });
    if (hits.length >= MAX) { console.log('# reached --max, stopping'); break; }
    // back to root
    const back = await evalJs(`(() => {
      const el = document.querySelector('[class*="share-breadcrumbs-root"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return JSON.stringify({ cx: r.left + r.width / 2, cy: r.top + r.height / 2 });
    })()`);
    if (back) { const bb = JSON.parse(back); await clickAt(bb.cx, bb.cy, false); await new Promise((r) => setTimeout(r, 1500)); }
  }

  console.log('# hits: ' + JSON.stringify(hits, null, 1));
  ws.close();
})().catch((e) => { console.error('ERROR ' + e.message); process.exit(1); });
