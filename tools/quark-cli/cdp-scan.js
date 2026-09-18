#!/usr/bin/env node
/**
 * cdp-scan.js - search every execution context of a page for UI text.
 * usage: node cdp-scan.js <urlSubstr> <text...>
 */
const HOST = (process.env.CDP_HOST || '127.0.0.1');
const PORT = Number(process.env.CDP_PORT || 9222);
const [needle, ...texts] = process.argv.slice(2);

(async () => {
  const list = await (await fetch(`http://${HOST}:${PORT}/json`)).json();
  const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const page = pages.find((p) => (p.url || '').includes(needle) || (p.title || '').includes(needle));
  if (!page) throw new Error('no page for ' + needle);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let id = 0;
  const contexts = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.executionContextCreated') contexts.push(m.params.context);
    if (m.method === 'Runtime.executionContextsCleared') contexts.length = 0;
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  const send = (method, params = {}) =>
    new Promise((res) => {
      const myId = ++id;
      pending.set(myId, res);
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  await send('Runtime.enable');
  await send('Page.enable');
  await new Promise((r) => setTimeout(r, 800));

  console.log(`# page ${page.title}; ${contexts.length} execution context(s)`);
  const probe = texts.length ? texts : ['下载'];
  for (const c of contexts) {
    for (const text of probe) {
      const expr = `(() => {
        const hits = [];
        const walk = (root) => {
          const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
          for (const el of all) {
            const t = (el.innerText || el.textContent || '').trim();
            if (t && t.length <= 14 && t.includes(${JSON.stringify(text)})) {
              const r = el.getBoundingClientRect();
              if (r.width > 4 && r.height > 4) hits.push(el.tagName + '.' + String(el.className || '').slice(0, 26) +
                ' [' + Math.round(r.left) + ',' + Math.round(r.top) + ',' + Math.round(r.width) + 'x' + Math.round(r.height) + '] "' + t + '"');
            }
          }
        };
        walk(document);
        return hits.slice(0, 15).join('\\n');
      })()`;
      const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, contextId: c.id });
      const val = res.result && res.result.result ? res.result.result.value : '';
      const err = res.result && res.result.exceptionDetails ? ' <exception>' : '';
      const checked = await send('Runtime.evaluate', {
        expression: `document.querySelectorAll('input[type=checkbox]').length + ' checkbox(es), ' + document.querySelectorAll('input[type=checkbox]:checked').length + ' checked'`,
        returnByValue: true,
        contextId: c.id,
      });
      const cval = checked.result && checked.result.result ? checked.result.result.value : '';
      console.log(`ctx ${c.id} (${(c.origin || '').slice(0, 40)}) "${text}"${err}:`);
      console.log(val ? val.split('\n').map((l) => '   ' + l).join('\n') : '   (none)');
      console.log(`   ${cval}`);
    }
  }
  ws.close();
})().catch((e) => {
  console.error('ERROR ' + e.message);
  process.exit(1);
});
