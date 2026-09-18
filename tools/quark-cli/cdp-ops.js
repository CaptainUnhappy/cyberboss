#!/usr/bin/env node
/**
 * cdp-ops.js - high-level operations on the Quark client's pages over CDP.
 *
 * These are the operations that were proven to work on this machine:
 *   - the share dialog and the main drive page are React apps reachable by CDP
 *   - plain element.click() does NOT drive them; real input events do
 *     (Input.dispatchMouseEvent), which is what this script uses
 *   - window/coordinate based clicking also works once the dialog handle is
 *     known (see quarkctl.py), but CDP is preferred: no coordinates involved
 *
 * Commands:
 *   list-targets
 *   share-info                      -> share metadata, rows, save button state, messages
 *   share-select --name <substr> [--only]   -> tick matching rows (--only untick others)
 *   share-enter --name <substr>     -> enter a folder row (double click)
 *   share-save [--expect <substr>]  -> click 保存 and report what happened
 *   main-open-saveas                -> switch the main page to 转存的内容
 *   main-list [--filter <substr>]   -> list rows / items of the main page
 *   main-select --name <substr> [--only]
 *   main-click-button --text <text> -> click a toolbar button by its label
 *   main-refresh                    -> click the list refresh control
 *
 * Every command prints one JSON object.
 */
const HOST = process.env.CDP_HOST || '127.0.0.1';
const PORT = Number(process.env.CDP_PORT || 9222);

const SHARE = 'share-link-window';
const MAIN = 'index.html';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

async function targets() {
  const res = await fetch(`http://${HOST}:${PORT}/json`);
  return res.json();
}

class Session {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.contexts = [];
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve);
      this.ws.addEventListener('error', () => reject(new Error('ws error')));
      setTimeout(() => reject(new Error('ws timeout')), 8000);
    });
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.executionContextCreated') this.contexts.push(m.params.context);
      if (m.method === 'Runtime.executionContextsCleared') this.contexts.length = 0;
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)(m);
        this.pending.delete(m.id);
      }
    });
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    await new Promise((r) => setTimeout(r, 500));
    return this;
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)));
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('timeout: ' + method));
        }
      }, 20000);
    });
  }

  async eval(expression) {
    const ctx = this.contexts[0];
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
      contextId: ctx ? ctx.id : undefined,
    });
    if (r.exceptionDetails) {
      const ex = r.exceptionDetails.exception || {};
      throw new Error('page exception: ' + (ex.description || JSON.stringify(r.exceptionDetails)));
    }
    return r.result ? r.result.value : undefined;
  }

  /** Click a DOM element by CSS selector using real input events. */
  async clickSelector(selector, { double = false } = {}) {
    const box = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return JSON.stringify({ cx: r.left + r.width / 2, cy: r.top + r.height / 2,
                              rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
                              text: (el.innerText || '').trim().slice(0, 40) });
    })()`);
    if (!box) return { ok: false, reason: 'selector not found: ' + selector };
    const info = JSON.parse(box);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: info.cx, y: info.cy, button: 'none', buttons: 0 });
    const counts = double ? [1, 2] : [1];
    for (const c of counts) {
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.cx, y: info.cy, button: 'left', buttons: 1, clickCount: c });
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.cx, y: info.cy, button: 'left', buttons: 0, clickCount: c });
      await new Promise((r) => setTimeout(r, 50));
    }
    return { ok: true, selector, target: info };
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

async function sessionFor(needle) {
  const list = await targets();
  const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const page = pages.find((p) => (p.url || '').includes(needle) || (p.title || '').includes(needle));
  if (!page) throw new Error(`no page target matching "${needle}"`);
  const s = await new Session(page.webSocketDebuggerUrl).open();
  s.page = page;
  return s;
}

// ---------------------------------------------------------------- share page

const SHARE_INFO_JS = `(() => {
  const text = (el) => (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
  const out = { url: location.href };
  const info = document.querySelector('[class*="ShareInfo__share-info"]');
  out.share = info ? text(info).slice(0, 120) : null;
  out.rows = Array.from(document.querySelectorAll('tr.ant-table-row')).map((tr) => {
    const r = tr.getBoundingClientRect();
    const cb = tr.querySelector('input.ant-checkbox-input');
    return { name: text(tr).slice(0, 70), checked: cb ? cb.checked : null,
             rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] };
  });
  const btn = document.querySelector('button.quark-cloud-drive-button');
  out.saveButton = btn ? { text: text(btn), disabled: btn.disabled,
                           rect: (() => { const b = btn.getBoundingClientRect();
                             return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; })() } : null;
  const msgs = [];
  document.querySelectorAll('[class*="ant-message"], [class*="message-wrap"], .ant-notification').forEach((el) => {
    const t = text(el);
    if (t && el.getBoundingClientRect().width > 0) msgs.push(t.slice(0, 100));
  });
  out.messages = Array.from(new Set(msgs)).slice(0, 5);
  const p = document.querySelector('.save-path');
  out.savePath = p ? text(p) : null;
  out.breadcrumb = (() => { const b = document.querySelector('[class*="breadcrumbs"]'); return b ? text(b).slice(0, 80) : null; })();
  return JSON.stringify(out);
})()`;

async function cmdShareInfo() {
  const s = await sessionFor(SHARE);
  const info = JSON.parse(await s.eval(SHARE_INFO_JS));
  s.close();
  return info;
}

async function cmdShareEnter(name) {
  const s = await sessionFor(SHARE);
  // find the row index whose text matches, then double-click its name cell
  const idx = await s.eval(`(() => {
    const rows = Array.from(document.querySelectorAll('tr.ant-table-row'));
    return rows.findIndex((tr) => (tr.innerText || '').includes(${JSON.stringify(name)}));
  })()`);
  if (idx < 0) { s.close(); return { ok: false, reason: 'row not found: ' + name }; }
  const res = await s.eval(`(() => {
    const rows = Array.from(document.querySelectorAll('tr.ant-table-row'));
    const cell = rows[${idx}].querySelector('td.share-td-file') || rows[${idx}];
    const r = cell.getBoundingClientRect();
    return JSON.stringify({ cx: r.left + r.width / 2, cy: r.top + r.height / 2, text: (cell.innerText || '').trim().slice(0, 50) });
  })()`);
  const t = JSON.parse(res);
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: t.cx, y: t.cy, button: 'none', buttons: 0 });
  for (const c of [1, 2]) {
    await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: t.cx, y: t.cy, button: 'left', buttons: 1, clickCount: c });
    await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: t.cx, y: t.cy, button: 'left', buttons: 0, clickCount: c });
    await new Promise((r) => setTimeout(r, 60));
  }
  await new Promise((r) => setTimeout(r, 1500));
  const after = JSON.parse(await s.eval(SHARE_INFO_JS));
  s.close();
  return { ok: true, entered: t.text, rowsAfter: after.rows, breadcrumb: after.breadcrumb };
}

async function cmdShareSelect(name, only) {
  const s = await sessionFor(SHARE);
  const res = await s.eval(`(() => {
    const text = (el) => (el.innerText || el.textContent || '').trim();
    const want = ${JSON.stringify(name)};
    const changed = [];
    document.querySelectorAll('tr.ant-table-row').forEach((tr) => {
      const cb = tr.querySelector('input.ant-checkbox-input');
      if (!cb) return;
      const match = text(tr).includes(want);
      if (match && !cb.checked) { cb.click(); changed.push('+' + text(tr).slice(0, 40)); }
      if (!match && ${only ? 'true' : 'false'} && cb.checked) { cb.click(); changed.push('-' + text(tr).slice(0, 40)); }
    });
    const btn = document.querySelector('button.quark-cloud-drive-button');
    return JSON.stringify({ changed, button: btn ? text(btn).slice(0, 30) : null });
  })()`);
  const parsed = JSON.parse(res);
  const info = JSON.parse(await s.eval(SHARE_INFO_JS));
  s.close();
  return { ...parsed, rows: info.rows, messages: info.messages };
}

async function cmdShareSave() {
  const s = await sessionFor(SHARE);
  const before = JSON.parse(await s.eval(SHARE_INFO_JS));
  const click = await s.clickSelector('button.quark-cloud-drive-button');
  await new Promise((r) => setTimeout(r, 2500));
  const after = JSON.parse(await s.eval(SHARE_INFO_JS));
  s.close();
  return { click, beforeButton: before.saveButton, afterButton: after.saveButton,
           messagesAfter: after.messages, rowsAfter: after.rows.length };
}

// ---------------------------------------------------------------- main page

const MAIN_LIST_JS = (filter) => `(() => {
  const text = (el) => (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
  const out = { url: location.href };
  const crumb = document.querySelector('.table-all-breadcrumb');
  out.breadcrumb = crumb ? text(crumb).slice(0, 100) : null;
  const f = ${JSON.stringify(filter || '')};
  const rows = [];
  document.querySelectorAll('tr.ant-table-row').forEach((tr) => {
    const t = text(tr);
    if (f && !t.includes(f)) return;
    const r = tr.getBoundingClientRect();
    const cb = tr.querySelector('input.ant-checkbox-input');
    rows.push({ name: t.slice(0, 70), checked: cb ? cb.checked : null,
                rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] });
  });
  out.tableRows = rows;
  const items = [];
  document.querySelectorAll('.auto-size-list-item, [class*="ColumnsFile__file-item"]').forEach((el) => {
    const t = text(el);
    if (!t || (f && !t.includes(f))) return;
    const r = el.getBoundingClientRect();
    items.push({ text: t.slice(0, 60), rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] });
  });
  out.treeItems = items.slice(0, 40);
  const buttons = [];
  document.querySelectorAll('button').forEach((b) => {
    const t = text(b);
    const r = b.getBoundingClientRect();
    if (r.width < 4) return;
    buttons.push({ text: t.slice(0, 20), disabled: b.disabled,
                   rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] });
  });
  out.buttons = buttons.slice(0, 20);
  const hits = [];
  document.querySelectorAll('*').forEach((n) => {
    const t = text(n);
    if (t && n.children.length === 0 && f && t.includes(f) && t.length < 80) hits.push(t.slice(0, 70));
  });
  out.textHits = Array.from(new Set(hits)).slice(0, 10);
  return JSON.stringify(out);
})()`;

async function cmdMainList(filter) {
  const s = await sessionFor(MAIN);
  const out = JSON.parse(await s.eval(MAIN_LIST_JS(filter)));
  s.close();
  return out;
}

async function cmdMainOpenSaveas() {
  const s = await sessionFor(MAIN);
  const res = await s.eval(`(() => {
    const text = (el) => (el.innerText || el.textContent || '').trim();
    const entry = Array.from(document.querySelectorAll('*')).find((el) => el.children.length === 0 && text(el) === '转存的内容');
    if (!entry) return JSON.stringify({ ok: false });
    entry.click();
    return JSON.stringify({ ok: true });
  })()`);
  await new Promise((r) => setTimeout(r, 2000));
  const after = JSON.parse(await s.eval(MAIN_LIST_JS('')));
  s.close();
  return { clicked: JSON.parse(res), url: after.url, breadcrumb: after.breadcrumb };
}

async function cmdMainRefresh() {
  const s = await sessionFor(MAIN);
  const sel = await s.eval(`(() => {
    const cands = Array.from(document.querySelectorAll('[class*="refresh"], [class*="reload"], [class*="update"]'));
    for (const el of cands) {
      const r = el.getBoundingClientRect();
      if (r.width > 8 && r.height > 8 && r.top < 220) {
        el.setAttribute('data-quarkctl-refresh', '1');
        return JSON.stringify({ cls: String(el.className || '').slice(0, 40),
                                rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] });
      }
    }
    return null;
  })()`);
  if (!sel) { s.close(); return { ok: false, reason: 'no refresh control found' }; }
  const click = await s.clickSelector('[data-quarkctl-refresh="1"]');
  await new Promise((r) => setTimeout(r, 2500));
  const after = JSON.parse(await s.eval(MAIN_LIST_JS('')));
  s.close();
  return { ok: true, control: JSON.parse(sel), click, breadcrumb: after.breadcrumb, rows: after.tableRows.length, treeItems: after.treeItems.length };
}

async function cmdMainSelect(name, only) {
  const s = await sessionFor(MAIN);
  const res = await s.eval(`(() => {
    const text = (el) => (el.innerText || el.textContent || '').trim();
    const want = ${JSON.stringify(name)};
    const changed = [];
    document.querySelectorAll('tr.ant-table-row').forEach((tr) => {
      const cb = tr.querySelector('input.ant-checkbox-input');
      if (!cb) return;
      const match = text(tr).includes(want);
      if (match && !cb.checked) { cb.click(); changed.push('+' + text(tr).slice(0, 40)); }
      if (!match && ${only ? 'true' : 'false'} && cb.checked) { cb.click(); changed.push('-' + text(tr).slice(0, 40)); }
    });
    return JSON.stringify({ changed, rowsSeen: document.querySelectorAll('tr.ant-table-row').length });
  })()`);
  s.close();
  return JSON.parse(res);
}

async function cmdMainClickButton(text) {
  const s = await sessionFor(MAIN);
  const idx = await s.eval(`(() => {
    const t = ${JSON.stringify(text)};
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.findIndex((b) => (b.innerText || '').trim().includes(t));
  })()`);
  if (idx < 0) { s.close(); return { ok: false, reason: 'button not found: ' + text }; }
  await s.eval(`document.querySelectorAll('button')[${idx}].setAttribute('data-quarkctl-btn','1')`);
  const click = await s.clickSelector('[data-quarkctl-btn="1"]');
  await new Promise((r) => setTimeout(r, 2000));
  const after = JSON.parse(await s.eval(MAIN_LIST_JS('')));
  s.close();
  return { ok: true, click, breadcrumb: after.breadcrumb, buttons: after.buttons };
}

async function cmdMainSelectItem(name, only) {
  // The left tree / list rows are NOT <tr> elements on this page; they are
  // .auto-size-list-item blocks. Selecting them means clicking the row block
  // (its checkbox column is rendered inside the block), so we click the row's
  // left edge where the checkbox sits.
  const s = await sessionFor(MAIN);
  const target = await s.eval(`(() => {
    const text = (el) => (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
    const want = ${JSON.stringify(name)};
    const items = Array.from(document.querySelectorAll('.auto-size-list-item, [class*="ColumnsFile__file-item"], [class*="file-click-wrap"]'));
    const hit = items.find((el) => text(el).includes(want));
    if (!hit) return null;
    hit.setAttribute('data-quarkctl-item', '1');
    const r = hit.getBoundingClientRect();
    return JSON.stringify({ text: text(hit).slice(0, 60),
                            rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
                            checkboxX: Math.round(r.left + 12), checkboxY: Math.round(r.top + r.height / 2) });
  })()`);
  if (!target) { s.close(); return { ok: false, reason: 'item not found: ' + name }; }
  const t = JSON.parse(target);
  // click the checkbox column of that row with a real event
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: t.checkboxX, y: t.checkboxY, button: 'none', buttons: 0 });
  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: t.checkboxX, y: t.checkboxY, button: 'left', buttons: 1, clickCount: 1 });
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: t.checkboxX, y: t.checkboxY, button: 'left', buttons: 0, clickCount: 1 });
  await new Promise((r) => setTimeout(r, 1500));
  const after = JSON.parse(await s.eval(MAIN_LIST_JS('')));
  s.close();
  return { ok: true, item: t, buttonsAfter: after.buttons, breadcrumb: after.breadcrumb };
}

async function cmdMainClickControl(text) {
  // Click any element (button, svg, div) whose text or title matches, by real
  // input events - works for controls that are not <button> elements.
  const s = await sessionFor(MAIN);
  const found = await s.eval(`(() => {
    const t = ${JSON.stringify(text)};
    const cands = Array.from(document.querySelectorAll('button, [role=button], a, div, span, svg, i'));
    for (const el of cands) {
      const own = ((el.innerText || '') + ' ' + (el.getAttribute && (el.getAttribute('title') || el.getAttribute('aria-label') || '') || '')).trim();
      if (!own || !own.includes(t)) continue;
      if (el.children.length > 6) continue;              // skip big containers
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      el.setAttribute('data-quarkctl-ctl', '1');
      return JSON.stringify({ tag: el.tagName, cls: String(el.className || '').slice(0, 40),
                              rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] });
    }
    return null;
  })()`);
  if (!found) { s.close(); return { ok: false, reason: 'control not found: ' + text }; }
  const click = await s.clickSelector('[data-quarkctl-ctl="1"]');
  await new Promise((r) => setTimeout(r, 2000));
  const after = JSON.parse(await s.eval(MAIN_LIST_JS('')));
  s.close();
  return { ok: true, control: JSON.parse(found), click, buttonsAfter: after.buttons };
}

async function main() {
  const cmd = process.argv[2];
  let out;
  switch (cmd) {
    case 'list-targets': {
      const list = await targets();
      out = list.filter((t) => t.type === 'page').map((t) => ({ title: t.title, url: t.url }));
      break;
    }
    case 'share-info': out = await cmdShareInfo(); break;
    case 'share-enter': out = await cmdShareEnter(arg('name')); break;
    case 'share-select': out = await cmdShareSelect(arg('name'), !!arg('only', false)); break;
    case 'share-save': out = await cmdShareSave(); break;
    case 'main-open-saveas': out = await cmdMainOpenSaveas(); break;
    case 'main-list': out = await cmdMainList(arg('filter', '')); break;
    case 'main-refresh': out = await cmdMainRefresh(); break;
    case 'main-select': out = await cmdMainSelect(arg('name'), !!arg('only', false)); break;
    case 'main-select-item': out = await cmdMainSelectItem(arg('name'), !!arg('only', false)); break;
    case 'main-click-control': out = await cmdMainClickControl(arg('text')); break;
    case 'main-click-button': out = await cmdMainClickButton(arg('text')); break;
    default:
      console.error('usage: cdp-ops.js <list-targets|share-info|share-enter|share-select|share-save|main-open-saveas|main-list|main-refresh|main-select|main-select-item|main-click-control|main-click-button> [--name X] [--only] [--filter X] [--text X]');
      process.exit(2);
  }
  console.log(JSON.stringify(out, null, 1));
}

main().catch((e) => {
  console.error('ERROR ' + e.message);
  process.exit(1);
});
