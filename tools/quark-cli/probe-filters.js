(() => {
  const text = (el) => (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
  const out = { url: location.href };
  const chips = [];
  document.querySelectorAll('*').forEach((el) => {
    const t = text(el);
    if (!t || t.length > 6) return;
    if (!/^(全部|有更新|合辑|访问记录)$/.test(t)) return;
    const r = el.getBoundingClientRect();
    if (r.width < 10 || r.height < 8) return;
    chips.push({ text: t, tag: el.tagName, cls: String(el.className || '').slice(0, 60),
                 parentCls: el.parentElement ? String(el.parentElement.className || '').slice(0, 60) : null,
                 rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] });
  });
  out.chips = chips.slice(0, 16);
  return JSON.stringify(out, null, 1);
})()
