(() => {
  const text = (el) => (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
  // double click the first row (folder) to enter it
  const row = document.querySelector('tr.ant-table-row');
  if (!row) return JSON.stringify({ ok: false, reason: 'no row' });
  const nameEl = row.querySelector('.filename, .task-name-text, td.share-td-file div') || row;
  const r = nameEl.getBoundingClientRect();
  return JSON.stringify({ ok: true, target: text(nameEl).slice(0, 60),
                          rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
                          cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) });
})()
