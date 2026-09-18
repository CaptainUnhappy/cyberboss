(() => {
  const out = { url: location.href, title: document.title };
  const text = (el) => (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
  // share metadata
  const info = document.querySelector('.ShareInfo__share-info--BTwXK');
  out.shareInfo = info ? text(info).slice(0, 120) : null;
  // every row in the share table
  const rows = [];
  document.querySelectorAll('tr.ant-table-row').forEach((tr) => {
    const r = tr.getBoundingClientRect();
    const cb = tr.querySelector('input.ant-checkbox-input');
    rows.push({
      name: text(tr).slice(0, 70),
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      checkbox: cb ? cb.checked : null,
    });
  });
  out.rows = rows.slice(0, 30);
  out.rowCount = rows.length;
  // footer: save button + destination
  const btn = document.querySelector('button.quark-cloud-drive-button');
  if (btn) {
    const b = btn.getBoundingClientRect();
    out.saveButton = { text: text(btn), rect: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)], disabled: btn.disabled };
  }
  const path = document.querySelector('.save-path');
  out.savePath = path ? text(path).slice(0, 80) : null;
  // any pdf mentions
  const pdfs = [];
  document.querySelectorAll('*').forEach((el) => {
    const t = (el.textContent || '').trim();
    if (t.length < 80 && /\.pdf/i.test(t) && el.children.length === 0) pdfs.push(t.slice(0, 60));
  });
  out.pdfs = Array.from(new Set(pdfs)).slice(0, 20);
  return JSON.stringify(out, null, 1);
})()
