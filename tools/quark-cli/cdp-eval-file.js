#!/usr/bin/env node
/**
 * cdp-eval-file.js - evaluate a JS file inside a page target's context.
 * usage: node cdp-eval-file.js <urlSubstr> <file.js> [contextIndex]
 */
const { readFileSync } = require('node:fs');

const HOST = process.env.CDP_HOST || '127.0.0.1';
const PORT = Number(process.env.CDP_PORT || 9222);
const [needle, file, ctxIndexArg] = process.argv.slice(2);

(async () => {
const list = await (await fetch(`http://${HOST}:${PORT}/json`)).json();
const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
const page = pages.find((p) => (p.url || '').includes(needle) || (p.title || '').includes(needle));
if (!page) {
  console.error('no page for ' + needle);
  process.exit(2);
}

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
await new Promise((r) => setTimeout(r, 600));

const ctxIdx = ctxIndexArg === undefined ? 0 : Number(ctxIndexArg);
const ctx = contexts[ctxIdx] || contexts[0];
const expression = readFileSync(file, 'utf8');
const res = await send('Runtime.evaluate', {
  expression,
  returnByValue: true,
  awaitPromise: true,
  userGesture: true,
  contextId: ctx ? ctx.id : undefined,
});
if (res.result && res.result.exceptionDetails) {
  const ex = res.result.exceptionDetails;
  console.error('EXCEPTION ' + (ex.exception && (ex.exception.description || ex.exception.value) ? (ex.exception.description || ex.exception.value) : JSON.stringify(ex)));
  process.exit(1);
}
const val = res.result && res.result.result ? res.result.result.value : undefined;
console.log(typeof val === 'string' ? val : JSON.stringify(val));
ws.close();
})().catch((err) => {
  console.error('ERROR ' + (err && err.message ? err.message : String(err)));
  process.exit(1);
});
