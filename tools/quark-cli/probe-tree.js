(() => {
  const text = (el) => (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
  const out = { url: location.href };
  // the left file tree: find the container that has the saved-folder entry
  const rows = [];
  document.querySelectorAll('.auto-size-list-item, [class*="ColumnsFile"], [class*="file-item"]').forEach((el) => {
    const t = text(el);
    if (!t) return;
    const r = el.getBoundingClientRect();
    if (r.width < 60 || r.height < 10) return;
    rows.push({ cls: String(el.className || '').slice(0, 34), text: t.slice(0, 60),
                rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] });
  });
  out.treeItems = rows.slice(0, 25);
  // breadcrumb
  const crumb = document.querySelector('.table-all-breadcrumb');
  out.breadcrumb = crumb ? text(crumb).slice(0, 90) : null;
  // detail panel count
  const cnt = Array.from(document.querySelectorAll('*')).find((n) => n.children.length === 0 && /个项目|个文件/.test(text(n)));
  out.panelCount = cnt ? text(cnt) : null;
  // anything with the pdf name?
  const pdfBits = [];
  document.querySelectorAll('*').forEach((n) => {
    const t = text(n);
    if (t && /pdf|Temu|夸克网盘免费领/i.test(t) && n.children.length === 0 && t.length < 70) pdfBits.push(t.slice(0, 60));
  });
  out.pdfMentions = Array.from(new Set(pdfBits)).slice(0, 10);
  return JSON.stringify(out, null, 1);
})()
