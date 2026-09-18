(() => {
  const dlLabel = String.fromCharCode(19979, 36733); // 下载
  const out = { url: location.href };
  // breadcrumb is now inside the folder; read the visible row rects for the ancestor list
  const target = '许蓝方正妹博士性学教室';
  const rows = [];
  document.querySelectorAll('*').forEach((el) => {
    const t = (el.innerText || '').trim();
    if (!t || t.length > 60 || t.indexOf(target) < 0) return;
    const b = el.getBoundingClientRect();
    if (b.width < 40 || b.height < 8) return;
    rows.push(el.tagName + '.' + String(el.className || '').slice(0, 34) +
              ' @' + Math.round(b.left) + ',' + Math.round(b.top) + ' ' + Math.round(b.width) + 'x' + Math.round(b.height) +
              ' txt="' + t.slice(0, 30) + '"');
  });
  out.rowsWithFolderName = rows.slice(0, 8);
  // the action bar's download button + whether it is disabled
  const btns = [];
  document.querySelectorAll('button').forEach((b) => {
    const t = (b.innerText || '').trim().replace(/\s+/g, ' ');
    if (t.indexOf(dlLabel) < 0 && t.length > 8) return;
    const r = b.getBoundingClientRect();
    btns.push('"' + t + '" @' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' +
              Math.round(r.width) + 'x' + Math.round(r.height) + (b.disabled ? ' DISABLED' : ' enabled'));
  });
  out.buttons = btns.slice(0, 12);
  // breadcrumb links (to navigate back up)
  const crumbs = [];
  document.querySelectorAll('*').forEach((el) => {
    const t = (el.innerText || '').trim();
    if (t === '全部' && el.children.length === 0) {
      const b = el.getBoundingClientRect();
      if (b.width > 4) crumbs.push('@' + Math.round(b.left) + ',' + Math.round(b.top) + ' ' + Math.round(b.width) + 'x' + Math.round(b.height));
    }
  });
  out.breadcrumbAll = crumbs.slice(0, 5);
  return JSON.stringify(out, null, 1);
})()
