(() => {
  const query = location.search;
  if (!query) return;
  for (const link of document.querySelectorAll('[data-keep-query]')) {
    const href = link.getAttribute('href');
    if (href && !href.includes('?')) link.setAttribute('href', href + query);
  }
})();
