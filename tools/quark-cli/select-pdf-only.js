(() => {
  const text = (el) => (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
  const rows = Array.from(document.querySelectorAll('tr.ant-table-row'));
  const before = rows.map((tr) => ({ name: text(tr).slice(0, 40), checked: tr.querySelector('input.ant-checkbox-input')?.checked }));
  // untick every row that is NOT the pdf
  const changed = [];
  rows.forEach((tr) => {
    const t = text(tr);
    const cb = tr.querySelector('input.ant-checkbox-input');
    if (!cb) return;
    const isPdf = /\.pdf/i.test(t);
    if (!isPdf && cb.checked) {
      cb.click();                     // react-friendly toggle
      changed.push(text(tr).slice(0, 40));
    }
    if (isPdf && !cb.checked) {
      cb.click();
      changed.push('(re)checked ' + text(tr).slice(0, 40));
    }
  });
  const after = rows.map((tr) => ({ name: text(tr).slice(0, 40), checked: tr.querySelector('input.ant-checkbox-input')?.checked }));
  const btn = document.querySelector('button.quark-cloud-drive-button');
  return JSON.stringify({ before, changed, after, button: btn ? text(btn) : null }, null, 1);
})()
