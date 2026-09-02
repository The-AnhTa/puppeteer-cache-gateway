import puppeteer from 'puppeteer-core';

const CDP_URL =
  process.env.CDP_URL ??
  'http://127.0.0.1:9222';

const TARGET_ORIGIN =
  process.env.TARGET_ORIGIN;

if (!TARGET_ORIGIN) {
  throw new Error(
    'TARGET_ORIGIN is required, e.g. https://example.com'
  );
}

const browser = await puppeteer.connect({
  browserURL: CDP_URL
});

try {
  const pages = await browser.pages();

  const page = pages.find((p) => {
    try {
      return (
        new URL(p.url()).origin === TARGET_ORIGIN
      );
    } catch {
      return false;
    }
  });

  if (!page) {
    throw new Error(
      `No open page found for origin: ${TARGET_ORIGIN}`
    );
  }

  console.log(`Page: ${await page.title()}`);
  console.log(`URL:  ${page.url()}`);
  console.log('');

  const controls = await page.evaluate(() => {

    function cleanText(value) {
      return (value ?? '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function describe(el) {
      const parentWithNodeKey =
        el.closest('[data-node-key]');

      return {
        tag:
          el.tagName.toLowerCase(),

        text:
          cleanText(el.innerText),

        id:
          el.id || null,

        role:
          el.getAttribute('role'),

        title:
          el.getAttribute('title'),

        ariaLabel:
          el.getAttribute('aria-label'),

        ariaSelected:
          el.getAttribute('aria-selected'),

        nodeKey:
          el.getAttribute('data-node-key') ??
          parentWithNodeKey?.getAttribute(
            'data-node-key'
          ) ??
          null
      };
    }

    /*
     * Only inspect elements that are plausibly
     * interactive.
     *
     * This script does NOT click anything.
     */
    const selectors = [
      'button',
      '[role="button"]',
      '[role="tab"]',
      '[role="menuitem"]',
      'a',
      '[data-node-key]'
    ];

    const elements =
      [...document.querySelectorAll(
        selectors.join(',')
      )];

    const seen =
      new Set();

    const result = [];

    for (const el of elements) {
      const item =
        describe(el);

      /*
       * Ignore elements without useful
       * identifying information.
       */
      if (
        !item.text &&
        !item.id &&
        !item.title &&
        !item.ariaLabel &&
        !item.nodeKey
      ) {
        continue;
      }

      /*
       * Deduplicate nested Ant Design
       * controls that represent the same thing.
       */
      const key =
        JSON.stringify([
          item.text,
          item.id,
          item.role,
          item.nodeKey
        ]);

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      result.push(item);
    }

    return result;
  });

  console.log(
    `Found ${controls.length} candidate controls`
  );

  console.log('');

  for (
    let i = 0;
    i < controls.length;
    i++
  ) {
    const c =
      controls[i];

    console.log(
      `--- Control ${i + 1} ---`
    );

    console.log(
      `Text:          ${c.text || '-'}`
    );

    console.log(
      `Tag:           ${c.tag || '-'}`
    );

    console.log(
      `Role:          ${c.role || '-'}`
    );

    console.log(
      `ID:            ${c.id || '-'}`
    );

    console.log(
      `data-node-key: ${c.nodeKey || '-'}`
    );

    console.log(
      `Title:         ${c.title || '-'}`
    );

    console.log(
      `aria-label:    ${c.ariaLabel || '-'}`
    );

    console.log(
      `aria-selected: ${c.ariaSelected || '-'}`
    );

    console.log('');
  }

} finally {

  /*
   * Leave the authenticated Edge browser
   * running.
   */
  await browser.disconnect();
}