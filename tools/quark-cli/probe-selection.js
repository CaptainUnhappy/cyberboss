(() => {
  const text = (el) => (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
  const out = { url: location.href };
  const items = Array.from(document.querySelectorAll('.auto-size-list-item, [class*="ColumnsFile__file-item"]'));
  out.items = items.slice(0, 20).map((el) => {
    const r = el.getBoundingClientRect();
    const cls = String(el.className || '');
    const inner = Array.from(el.querySelectorAll('*')).filter((n) => /check|select/i.test(String(n.className || ''))).map((n) => String(n.className).slice(0, 40));
    return { text: text(el).slice(0, 40), cls: cls.slice(0, 80),
             selected: /selected|checked|active/i.test(cls),
             rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
             innerSelectors: inner.slice(0, 4) };
  });
  // any checkbox-ish DOM anywhere
  const boxes = [];
  document.querySelectorAll('input[type=checkbox], [class*="ant-checkbox"], [class*="checkbox"]').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 4) return;
    boxes.push({ tag: el.tagName, cls: String(el.className || '').slice(0, 40),
                 checked: el.checked === undefined ? null : el.checked,
                 rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] });
  });
  out.checkboxes = boxes.slice(0, 12);
  const bar = document.querySelector('[class*="FileHeader__header-operation"]');
  out.headerOperation = bar ? text(bar).slice(0, 120) : null;
  return JSON.stringify(out, null, 1);
})()
