(() => {
  const text = (el) => (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
  const out = { url: location.href };
  // 1) go to the "转存的内容" (saveas) view through the left tree entry
  const entry = Array.from(document.querySelectorAll('*')).find(
    (el) => el.children.length === 0 && text(el) === '转存的内容'
  );
  if (entry) {
    const r = entry.getBoundingClientRect();
    entry.click();
    out.clickedEntry = { rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] };
  } else {
    out.clickedEntry = null;
  }
  // 2) find the refresh control in the header (right side)
  const cands = [];
  document.querySelectorAll('svg, i, span, div, button').forEach((el) => {
    const cls = String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '');
    if (/refresh|reload|update/i.test(cls)) {
      const r = el.getBoundingClientRect();
      if (r.width > 6 && r.height > 6) cands.push(cls.slice(0, 40) + ' @' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    }
  });
  out.refreshCandidates = cands.slice(0, 8);
  return JSON.stringify(out, null, 1);
})()
