(() => {
  const text = (el) => (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
  // click the refresh control if it exists
  const el = document.querySelector('[class*="menu-update"]');
  let clicked = null;
  if (el) {
    const r = el.getBoundingClientRect();
    clicked = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
    el.click();
  }
  // then dump whatever list items are visible
  const items = [];
  document.querySelectorAll('*').forEach((n) => {
    const t = text(n);
    if (!t || t.length > 60) return;
    if (n.children.length !== 0) return;
    const r = n.getBoundingClientRect();
    if (r.width < 30 || r.height < 8) return;
    if (/项目|文件|文件夹|刷新|全部|最近|视频|图片|文档/.test(t) && t.length < 6) return;
    items.push(t.slice(0, 50) + ' @' + Math.round(r.left) + ',' + Math.round(r.top));
  });
  return JSON.stringify({ clickedRefresh: clicked, visibleTexts: items.slice(0, 40) }, null, 1);
})()
