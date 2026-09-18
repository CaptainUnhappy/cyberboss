(() => {
  const out = [];
  const buttons = document.querySelectorAll('button, div[role=button], a');
  buttons.forEach((e) => {
    const t = (e.innerText || '').trim().replace(/\s+/g, ' ');
    if (!t || t.length > 10) return;
    const b = e.getBoundingClientRect();
    if (b.width < 4 || b.height < 4) return;
    out.push(e.tagName + ' "' + t + '" @' + Math.round(b.left) + ',' + Math.round(b.top) +
             ' ' + Math.round(b.width) + 'x' + Math.round(b.height));
  });
  const checks = document.querySelectorAll('input[type=checkbox]');
  return JSON.stringify({
    visibleControls: out.slice(0, 40),
    checkboxCount: checks.length,
    checkedCount: document.querySelectorAll('input[type=checkbox]:checked').length,
    bodyTextHead: (document.body ? document.body.innerText : '').slice(0, 160),
  }, null, 1);
})()
