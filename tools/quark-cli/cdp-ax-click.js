#!/usr/bin/env node
/**
 * cdp-ax-click.js - list or click AX nodes by name in a page target.
 * usage:
 *   node cdp-ax-click.js <urlSubstr> list [needle]
 *   node cdp-ax-click.js <urlSubstr> click <exactName> [dbl]
 */
const HOST = process.env.CDP_HOST || '127.0.0.1';
const PORT = Number(process.env.CDP_PORT || 9222);
const [needle, mode, arg, how] = process.argv.slice(2);

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
  const send = (method, params = {}) => new Promise((res) => {
    const myId = ++id; pending.set(myId, res);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });

  await send('Accessibility.enable');
  const { nodes } = (await send('Accessibility.getFullAXTree')).result;
  const named = nodes.filter((n) => n.name && String(n.name.value || '').trim() && !n.ignored);

  if (mode === 'list') {
    const filter = (arg || '').trim();
    const shown = named.filter((n) => !filter || String(n.name.value).includes(filter));
    console.log(`# ${nodes.length} AX nodes, ${named.length} named`);
    for (const n of shown.slice(0, 60)) {
      console.log(`${(n.role && n.role.value) || '?'}\tbackend=${n.backendDOMNodeId || '-'}\t${String(n.name.value).slice(0, 70)}`);
    }
    ws.close();
    return;
  }

  if (mode === 'click') {
    const want = String(arg);
    const hit = named.find((n) => String(n.name.value).trim() === want)
      || named.find((n) => String(n.name.value).includes(want));
    if (!hit) throw new Error('no AX node named ' + want);
    const role = (hit.role && hit.role.value) || '?';
    const name = String(hit.name.value).slice(0, 60);
    const resolved = await send('DOM.resolveNode', { backendNodeId: hit.backendDOMNodeId });
    const objectId = resolved.result.object.objectId;

    // 1) read the element's centre in viewport coordinates
    const boxRes = await send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function () {
        const el = this.nodeType === 1 ? this : (this.parentElement || this);
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return JSON.stringify({ tag: el.tagName, cls: String(el.className || '').slice(0, 40),
                                text: (el.innerText || '').trim().slice(0, 40),
                                cx: r.left + r.width / 2, cy: r.top + r.height / 2,
                                rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] });
      }`,
      returnByValue: true,
      userGesture: true,
    });
    const info = JSON.parse(boxRes.result.result.value);

    // 2) deliver real trusted mouse event(s) through the browser input pipeline
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: info.cx, y: info.cy, button: 'none', buttons: 0 });
    if (how === 'dbl') {
      for (const count of [1, 2]) {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.cx, y: info.cy, button: 'left', buttons: 1, clickCount: count });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.cx, y: info.cy, button: 'left', buttons: 0, clickCount: count });
        await new Promise((r) => setTimeout(r, 60));
      }
    } else {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.cx, y: info.cy, button: 'left', buttons: 1, clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.cx, y: info.cy, button: 'left', buttons: 0, clickCount: 1 });
    }

    console.log(JSON.stringify({ ok: true, role, name, mode: how || 'click', target: info }));
    ws.close();
    return;
  }
})().catch((e) => { console.error('ERROR ' + e.message); process.exit(1); });
