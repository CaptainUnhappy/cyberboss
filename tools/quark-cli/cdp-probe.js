#!/usr/bin/env node
/**
 * cdp-probe.js - read identity + page list from a specific DevTools endpoint host.
 * usage: node cdp-probe.js <host> [port]
 */
const host = process.argv[2] || '127.0.0.1';
const port = Number(process.argv[3] || 9222);
const base = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;

(async () => {
  const res = await fetch(`http://${base}:${port}/json`);
  const list = await res.json();
  const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  console.log(`# ${host}:${port} -> ${pages.length} page targets`);
  for (const p of pages) console.log(`  ${p.title} | ${(p.url || '').slice(0, 70)}`);

  const target = pages.find((p) => (p.url || '').includes('share-link-window')) || pages.find((p) => (p.url || '').includes('index.html')) || pages[0];
  if (!target) return;
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('ws error')));
    setTimeout(() => reject(new Error('ws timeout')), 8000);
  });
  const expr = `JSON.stringify({title:document.title, uid:(JSON.parse(localStorage.getItem('USER_INFO')||'{}').uid||'-'), screen:[window.screen?window.screen.width:'?',window.screen?window.screen.height:'?']})`;
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
  const out = await new Promise((resolve, reject) => {
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id === 1) resolve(m.result && m.result.result ? m.result.result.value : JSON.stringify(m));
    });
    setTimeout(() => reject(new Error('eval timeout')), 8000);
  });
  console.log(`# identity: ${out}`);
  ws.close();
})().catch((e) => {
  console.log(`ERR ${host}:${port} -> ${e.message}`);
  process.exit(1);
});
