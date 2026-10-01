/*
 * This expression runs against a cloned DOM in the attached page.
 * It reads rendered text and markup only. It never reads cookies,
 * storage, service workers, request headers, or browser profile data.
 */
export function buildSanitizeExpression() {
  return String.raw`
(() => {
  'use strict';

  const normalizeText = value =>
    String(value ?? '')
      .replace(/\u00a0/g, ' ')
      .split(/\r?\n/)
      .map(line => line.replace(/[ \t]+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');

  const visibleText =
    normalizeText(document.body?.innerText);

  const clone =
    document.documentElement.cloneNode(true);

  const comments = [];
  const walker = document.createTreeWalker(
    clone,
    NodeFilter.SHOW_COMMENT
  );

  while (walker.nextNode()) {
    comments.push(walker.currentNode);
  }

  for (const comment of comments) {
    comment.remove();
  }

  clone.querySelectorAll([
    'script',
    'noscript',
    'iframe',
    'object',
    'embed',
    'template',
    'base',
    'link',
    'style',
    'meta',
    'source',
    'track'
  ].join(',')).forEach(element => element.remove());

  clone.querySelectorAll(
    '[hidden], [aria-hidden="true"], input[type="hidden"]'
  ).forEach(element => element.remove());

  for (const form of [...clone.querySelectorAll('form')]) {
    const replacement = document.createElement('div');
    replacement.setAttribute('data-snapshot-form', 'neutralized');
    replacement.replaceChildren(...form.childNodes);
    form.replaceWith(replacement);
  }

  for (const anchor of [...clone.querySelectorAll('a')]) {
    const replacement = document.createElement('span');
    replacement.setAttribute('data-snapshot-link', 'neutralized');
    replacement.replaceChildren(...anchor.childNodes);
    anchor.replaceWith(replacement);
  }

  for (const button of [...clone.querySelectorAll('button')]) {
    const replacement = document.createElement('span');
    replacement.setAttribute('data-snapshot-control', 'neutralized');
    replacement.replaceChildren(...button.childNodes);
    button.replaceWith(replacement);
  }

  clone.querySelectorAll(
    'input, textarea, select, option, datalist'
  ).forEach(element => element.remove());

  const networkAttributes = new Set([
    'action',
    'cite',
    'data',
    'formaction',
    'href',
    'longdesc',
    'manifest',
    'ping',
    'poster',
    'profile',
    'src',
    'srcdoc',
    'srcset',
    'usemap'
  ]);

  const suspiciousName =
    /(token|authorization|auth|cookie|session|secret|password|passwd|credential|csrf)/i;
  const suspiciousValue =
    /(bearer\s+|access_token|refresh_token|authorization\s*[:=]|token\s*=)/i;

  for (const element of [clone, ...clone.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();

      if (
        name.startsWith('on') ||
        name.endsWith(':href') ||
        (
          name.startsWith('data-') &&
          !name.startsWith('data-snapshot-')
        ) ||
        networkAttributes.has(name) ||
        suspiciousName.test(name) ||
        suspiciousValue.test(attribute.value) ||
        name === 'style' ||
        name === 'value' ||
        name === 'nonce' ||
        name === 'contenteditable' ||
        name === 'autofocus' ||
        name === 'form' ||
        name === 'formmethod' ||
        name === 'formenctype' ||
        name === 'formtarget'
      ) {
        element.removeAttribute(attribute.name);
      }
    }

    if (
      element.getAttribute('role') === 'button' ||
      element.getAttribute('role') === 'link'
    ) {
      element.setAttribute('role', 'presentation');
      element.removeAttribute('tabindex');
    }
  }

  return {
    title: normalizeText(document.title),
    html: '<!doctype html>\n' + clone.outerHTML,
    text: visibleText
  };
})()
  `.trim();
}
