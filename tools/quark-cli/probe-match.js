(() => {
  const clean = (s) => (s || '').replace(/[^0-9A-Za-z\u4e00-\u9fff]+/g, '');
  const items = Array.from(document.querySelectorAll(
    '.auto-size-list-item, [class*="ColumnsFile__file-item"], [class*="file-click-wrap"], tr.ant-table-row'));
  const want = clean('夸克网盘免费领1T空间教程');
  const norm = items.map((el) => clean(el.textContent));
  return JSON.stringify({
    itemsSeen: items.length,
    want: want,
    wantLen: want.length,
    firstFew: norm.slice(0, 6).map((s) => s.slice(0, 50)),
    hits: norm.filter((s) => s.includes(want)).length,
    itemClsSample: items.slice(0, 3).map((el) => String(el.className || '').slice(0, 40)),
  }, null, 1);
})()
