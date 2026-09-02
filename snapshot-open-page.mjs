const snapshot = await page.evaluate(() => {
  const clone =
    document.documentElement.cloneNode(true);

  clone.querySelectorAll(
    [
      'script',
      'style',
      'noscript',
      'iframe',
      'object',
      'embed',
      'link',
      'base',
      'meta[http-equiv="refresh"]',
      'input[type="password"]',
      'input[type="hidden"]',
      '[hidden]',
      '[aria-hidden="true"]'
    ].join(',')
  ).forEach(el => el.remove());

  const networkAttrs = new Set([
    'src',
    'srcset',
    'poster',
    'href',
    'action',
    'formaction'
  ]);

  for (const el of [clone, ...clone.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();

      // Remove network-capable attributes entirely.
      // Do not preserve potentially sensitive URLs.
      if (networkAttrs.has(name)) {
        el.removeAttribute(attr.name);
        continue;
      }

      if (
        name.startsWith('on') ||
        name === 'srcdoc' ||
        name === 'style' ||
        /(^|[-_:])(token|secret|password|passwd|auth|session|csrf)([-_:]|$)/i
          .test(name)
      ) {
        el.removeAttribute(attr.name);
      }
    }
  }

  // Human/LLM-friendly text from the currently rendered page.
  const text =
    (document.body?.innerText ?? '')
      .replace(/\u00a0/g, ' ')
      .split(/\r?\n/)
      .map(line =>
        line
          .replace(/[ \t]+/g, ' ')
          .trim()
      )
      .filter(Boolean)
      .join('\n');

  return {
    title: document.title,
    url: location.href,
    html:
      '<!doctype html>\n' +
      clone.outerHTML,
    text
  };
});