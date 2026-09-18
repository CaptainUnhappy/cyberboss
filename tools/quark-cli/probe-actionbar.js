(() => {
  const out = { url: location.href, title: document.title };
  const vis = (el) => {
    const b = el.getBoundingClientRect();
    return b.width > 4 && b.height > 4;
  };
  // any element whose text is exactly the download label
  const dlLabel = String.fromCharCode(19979, 36733); // 下载
  const hits = [];
  document.querySelectorAll('*').forEach((el) => {
    const t = (el.innerText || '').trim();
    if (t === dlLabel && vis(el)) {
      const b = el.getBoundingClientRect();
      hits.push(el.tagName + '.' + String(el.className || '').slice(0, 30) + ' @' +
                Math.round(b.left) + ',' + Math.round(b.top) + ' ' +
                Math.round(b.width) + 'x' + Math.round(b.height));
    }
  });
  out.downloadLabelHits = hits.slice(0, 10);
  out.iframes = Array.from(document.querySelectorAll('iframe')).map((f) => f.src || '(no src)');
  out.checked = document.querySelectorAll('input[type=checkbox]:checked').length;
  out.checkboxes = document.querySelectorAll('input[type=checkbox]').length;
  out.bodyHead = (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 200);
  return JSON.stringify(out, null, 1);
})()
