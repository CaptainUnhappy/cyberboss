(() => {
  const text = (el) => (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
  const pick = (x, y) => {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const chain = [];
    let cur = el;
    for (let i = 0; i < 5 && cur; i++) {
      const r = cur.getBoundingClientRect();
      chain.push(cur.tagName + '.' + String(cur.className || '').slice(0, 44) +
                 ' [' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ']' +
                 ' "' + (cur.innerText || '').trim().slice(0, 20) + '"');
      cur = cur.parentElement;
    }
    return chain;
  };
  const out = {
    at_190_171: pick(190, 171),
    at_186_171: pick(186, 171),
    at_178_171: pick(178, 171),
    at_190_160: pick(190, 160),
  };
  // also list the filter menu items with their current classes
  out.filterItems = [];
  document.querySelectorAll('li.ant-menu-item').forEach((li) => {
    const r = li.getBoundingClientRect();
    out.filterItems.push({ text: text(li), cls: String(li.className).replace('ant-menu-item', '').trim().slice(0, 40),
                           rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] });
  });
  return JSON.stringify(out, null, 1);
})()
