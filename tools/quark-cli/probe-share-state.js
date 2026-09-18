(() => {
  const text = (el) => (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
  const out = { url: location.href };
  const btn = document.querySelector('button.quark-cloud-drive-button');
  out.saveButton = btn ? { text: text(btn), disabled: btn.disabled } : null;
  const rows = [];
  document.querySelectorAll('tr.ant-table-row').forEach((tr) => {
    rows.push({ name: text(tr).slice(0, 46), checked: tr.querySelector('input.ant-checkbox-input')?.checked });
  });
  out.rows = rows;
  // any toast/message element visible?
  const msgs = [];
  document.querySelectorAll('.ant-message, .ant-message-notice, .message-wrap, .ant-notification').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width > 0) msgs.push(text(el).slice(0, 80));
  });
  out.messages = msgs.slice(0, 5);
  const path = document.querySelector('.save-path');
  out.savePath = path ? text(path) : null;
  return JSON.stringify(out, null, 1);
})()
