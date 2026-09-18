#!/usr/bin/env node
/**
 * cdp-drive.js - drive the Quark client's pages over the Chrome DevTools Protocol.
 *
 * Why: on this machine synthetic input (WM_*, SendInput, UIA) never reaches the
 * client's in-page controls, but the client is Chromium and - when launched with
 * --remote-debugging-port - exposes its pages to CDP. Runtime.evaluate in the
 * right frame lets us click DOM elements directly, with no pointer synthesis.
 *
 * The client renders its UI inside same-origin iframes, so every command can
 * target a frame by index; `frames` lists them first.
 *
 * Usage:
 *   node cdp-drive.js list                          # page targets (host:port from CDP_HOST/CDP_PORT)
 *   node cdp-drive.js frames  <urlSubstr>           # frame tree of that page
 *   node cdp-drive.js dom     <urlSubstr> [needle] [frameIndex]
 *   node cdp-drive.js click   <urlSubstr> <text>    [frameIndex]
 *   node cdp-drive.js eval    <urlSubstr> <js>      [frameIndex]
 *   node cdp-drive.js text    <urlSubstr> [needle]  [frameIndex]   # readable DOM text dump
 *
 * Zero dependencies: uses the fetch/WebSocket built into Node >= 22.
 */

const RAW_HOST = process.env.CDP_HOST || '127.0.0.1';
const HOST = RAW_HOST.includes(':') && !RAW_HOST.startsWith('[') ? `[${RAW_HOST}]` : RAW_HOST;
const PORT = Number(process.env.CDP_PORT || 9222);

async function targets() {
  const res = await fetch(`http://${HOST}:${PORT}/json`);
  if (!res.ok) throw new Error(`GET /json -> HTTP ${res.status}`);
  return res.json();
}

function pickPage(list, needle) {
  const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!needle) return pages[0];
  const hit = pages.filter((t) => (t.url || '').includes(needle) || (t.title || '').includes(needle));
  if (!hit.length) {
    throw new Error(`no page target matches "${needle}"; available: ` +
      pages.map((p) => `${p.title}|${(p.url || '').slice(0, 40)}`).join(' ; '));
  }
  return hit[0];
}

class Session {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.frames = new Map(); // frameId -> url
    this.contexts = []; // execution contexts (integer ids)
  }

  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const fail = (e) => reject(new Error('websocket: ' + (e && e.message ? e.message : 'error')));
      ws.addEventListener('open', () => resolve(this));
      ws.addEventListener('error', fail);
      ws.addEventListener('message', (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.method === 'Page.frameNavigated' && msg.params && msg.params.frame) {
          this.frames.set(msg.params.frame.id, msg.params.frame.url);
        }
        if (msg.method === 'Runtime.executionContextCreated' && msg.params && msg.params.context) {
          const c = msg.params.context;
          this.contexts.push({ id: c.id, frameId: c.auxData ? c.auxData.frameId : undefined,
                               url: (c.origin || '') + ' ' + (c.name || '') });
        }
        if (msg.method === 'Runtime.executionContextsCleared') {
          this.contexts = [];
        }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(JSON.stringify(msg.error)));
          else res(msg.result);
        }
      });
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout waiting for ${method}`));
        }
      }, 15000);
    });
  }

  async refreshFrames() {
    await this.send('Page.enable');
    try {
      const tree = await this.send('Page.getFrameTree');
      const walk = (node) => {
        if (!node) return;
        const f = node.frame || {};
        this.frames.set(f.id, f.url || '(no url)');
        for (const child of node.childFrames || []) walk(child);
      };
      walk(tree.frameTree);
    } catch {}
    return this.frames;
  }

  async evaluate(expression, frameId) {
    const params = { expression, returnByValue: true, awaitPromise: false, userGesture: true };
    if (frameId) params.contextId = frameId; // contextId == frameId for the default context
    const res = await this.send('Runtime.evaluate', params);
    if (res.exceptionDetails) {
      const ex = res.exceptionDetails.exception || {};
      throw new Error('page exception: ' + (ex.description || ex.value || JSON.stringify(res.exceptionDetails)));
    }
    return res.result ? res.result.value : undefined;
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

const HELPERS = `
window.__qk = {
  all: () => Array.from(document.querySelectorAll('button, a, div[role=button], span, li, input, i')),
  text: (el) => (el.innerText || el.textContent || el.value || '').trim().replace(/\\s+/g, ' '),
  byText: (needle, exact) => window.__qk.all().filter((el) => {
    const t = window.__qk.text(el);
    if (!t) return false;
    return exact ? t === needle : t.includes(needle);
  }),
  deepest: (els) => els.filter((el) => !els.some((o) => o !== el && el.contains(o))),
  click: (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, view: window,
                   clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
    return true;
  },
};
true;
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) {
    console.error('usage: cdp-drive.js list|frames|dom|click|eval|text ...');
    process.exit(2);
  }

  if (cmd === 'list') {
    const list = await targets();
    for (const t of list) console.log(`${t.type}\t${t.title}\t${t.url}`);
    return;
  }

  if (cmd === 'attach') {
    // Discover every target the browser knows about, including OOPIFs/webviews
    // that Page.getFrameTree does not cover.
    const list = await targets();
    const browserWs = list.find((t) => t.webSocketDebuggerUrl && t.type === 'browser');
    const anyWs = (list[0] || {}).webSocketDebuggerUrl;
    const wsUrl = (browserWs ? browserWs.webSocketDebuggerUrl
      : anyWs.replace(/\/devtools\/page\/.*$/, '/devtools/browser/' + (process.env.BROWSER_ID || '')));
    const sess = await new Session(wsUrl).open();
    await sess.send('Target.setDiscoverTargets', { discover: true });
    await sess.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    const infos = [];
    sess.ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.method === 'Target.targetCreated' || m.method === 'Target.attachedToTarget') {
        const ti = m.params.targetInfo || (m.params.targetInfo && m.params.targetInfo) || {};
        const info = m.params.targetInfo || {};
        const t = m.params.targetInfo ? m.params.targetInfo : ti;
        infos.push(`${t.type || '?'}\t${t.title || ''}\t${(t.url || '').slice(0, 90)}`);
      }
    });
    await new Promise((r) => setTimeout(r, 2500));
    const uniq = Array.from(new Set(infos));
    for (const line of uniq) console.log(line);
    console.log(`# ${uniq.length} target(s) seen`);
    sess.close();
    return;
  }

  const [needle, arg, frameArg] = rest;
  const frameIndex = frameArg === undefined ? 0 : Number(frameArg);
  const list = await targets();
  const target = pickPage(list, needle);
  if (!target) throw new Error('no page target');
  const session = await new Session(target.webSocketDebuggerUrl).open();
  console.log(`# page: ${target.title} | ${(target.url || '').slice(0, 60)}`);

  if (cmd === 'ax') {
    // Dump the accessibility tree: this sees real controls regardless of shadow
    // DOM / custom elements, which plain querySelectorAll misses in this client.
    await session.send('Accessibility.enable').catch(() => {});
    const { nodes } = await session.send('Accessibility.getFullAXTree', {});
    const roles = {};
    const interesting = [];
    for (const n of nodes) {
      const role = n.role ? n.role.value : '?';
      roles[role] = (roles[role] || 0) + 1;
      const name = n.name ? String(n.name.value || '') : '';
      if (!name) continue;
      if (role === 'StaticText' || role === 'InlineTextBox' || role === 'generic') continue;
      interesting.push(`${role}\t${n.ignored ? 'IGNORED' : 'ok'}\tnode=${n.nodeId}\tbackend=${n.backendDOMNodeId || '-'}\t${name.slice(0, 60)}`);
    }
    console.log(`# ${nodes.length} AX nodes; roles: ${JSON.stringify(roles)}`);
    const want = (arg || '').trim();
    const shown = want ? interesting.filter((l) => l.includes(want)) : interesting;
    console.log(shown.slice(0, 120).join('\n') || '(no named nodes)');
    session.close();
    return;
  }

  if (cmd === 'axclick') {
    // Resolve an AX node whose name matches, then click its DOM element.
    await session.send('Accessibility.enable').catch(() => {});
    const { nodes } = await session.send('Accessibility.getFullAXTree', {});
    const want = (arg || '').trim();
    const hit = nodes.find((n) => n.name && String(n.name.value || '').trim() === want && !n.ignored)
      || nodes.find((n) => n.name && String(n.name.value || '').includes(want) && !n.ignored);
    if (!hit || !hit.backendDOMNodeId) {
      console.log(JSON.stringify({ ok: false, want, reason: 'no AX node with a backend DOM node' }));
      session.close();
      return;
    }
    const { object } = await session.send('DOM.resolveNode', { backendNodeId: hit.backendDOMNodeId });
    const call = await session.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function () {
        const el = this.nodeType === 1 ? this : (this.parentElement || this);
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        const opts = { bubbles: true, cancelable: true, view: window,
                       clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
        el.dispatchEvent(new PointerEvent('pointerdown', opts));
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new PointerEvent('pointerup', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new MouseEvent('click', opts));
        return JSON.stringify({ tag: el.tagName, cls: String(el.className || '').slice(0, 40),
                                text: (el.innerText || el.textContent || '').trim().slice(0, 40),
                                rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] });
      }`,
      returnByValue: true,
      userGesture: true,
    });
    const detail = call.result ? call.result.value : JSON.stringify(call);
    console.log(JSON.stringify({ ok: true, role: hit.role && hit.role.value, name: want, clicked: detail }));
    session.close();
    return;
  }

  const frames = await session.refreshFrames();
  await session.send('Runtime.enable').catch(() => {});
  await new Promise((r) => setTimeout(r, 400));
  const frameList = Array.from(frames.entries()).map(([id, url], i) => ({ i, id, url }));
  if (cmd === 'frames') {
    for (const f of frameList) console.log(`frame[${f.i}] ${f.id} ${f.url || '(top)'}`);
    for (const c of session.contexts) console.log(`context id=${c.id} frame=${c.frameId} ${c.url}`);
    session.close();
    return;
  }
  const frame = frameList[frameIndex] || frameList[0];
  const ctx = session.contexts.find((c) => c.frameId === (frame && frame.id)) || session.contexts[0];
  if (frame) console.log(`# frame[${frameIndex}]: ${frame.url || '(top)'}  ctx=${ctx ? ctx.id : 'default'}`);
  const contextId = ctx ? ctx.id : undefined;

  await session.evaluate(HELPERS, contextId).catch(() => {});
  void arg;

  if (cmd === 'dom') {
    const out = await session.evaluate(`(() => {
      const els = window.__qk.byText(${JSON.stringify(arg || '')}, false);
      const deep = window.__qk.deepest(els);
      return deep.slice(0, 80).map((el, i) => {
        const r = el.getBoundingClientRect();
        return i + '\\t' + el.tagName + '\\tclass=' + String(el.className || '').slice(0, 36) +
               '\\trect=' + Math.round(r.left) + ',' + Math.round(r.top) + ',' + Math.round(r.width) + 'x' + Math.round(r.height) +
               '\\ttext=' + window.__qk.text(el).slice(0, 70);
      }).join('\\n');
    })()`, contextId);
    console.log(out || '(no matches)');
  } else if (cmd === 'text') {
    const out = await session.evaluate(`(() => {
      const needle = ${JSON.stringify(arg || '')};
      const t = (document.body ? (document.body.innerText || '') : '');
      if (!needle) return t.slice(0, 4000);
      const lines = t.split('\\n').filter((l) => l.includes(needle));
      return lines.slice(0, 60).join('\\n');
    })()`, contextId);
    console.log(out || '(empty)');
  } else if (cmd === 'click') {
    const out = await session.evaluate(`(() => {
      const exact = window.__qk.byText(${JSON.stringify(arg)}, true);
      const loose = window.__qk.byText(${JSON.stringify(arg)}, false);
      const cands = window.__qk.deepest(exact).concat(window.__qk.deepest(loose));
      if (!cands.length) return JSON.stringify({ ok: false, needle: ${JSON.stringify(arg)}, loose: loose.length });
      const el = cands[0];
      const info = { tag: el.tagName, cls: String(el.className || '').slice(0, 40), text: window.__qk.text(el).slice(0, 60) };
      window.__qk.click(el);
      return JSON.stringify({ ok: true, clicked: info, candidates: cands.length });
    })()`, contextId);
    console.log(out);
  } else if (cmd === 'eval') {
    const out = await session.evaluate(arg, contextId);
    console.log(typeof out === 'string' ? out : JSON.stringify(out));
  } else {
    throw new Error('unknown command: ' + cmd);
  }
  session.close();
}

main().catch((err) => {
  console.error('ERROR ' + err.message);
  process.exit(1);
});
