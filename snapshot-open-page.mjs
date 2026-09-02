import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const CDP_URL =
  process.env.CDP_URL ??
  'http://127.0.0.1:9222';

const TARGET_ORIGIN = process.env.TARGET_ORIGIN;

const READY_SELECTOR =
  process.env.READY_SELECTOR ??
  'body';

const CACHE_DIR =
  process.env.CACHE_DIR ??
  'C:\\agent-web-cache\\semsplus';

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
      return new URL(p.url()).origin === TARGET_ORIGIN;
    } catch {
      return false;
    }
  });

  if (!page) {
    throw new Error(
      `No open page found for origin: ${TARGET_ORIGIN}`
    );
  }

  console.log(`Using page: ${await page.title()}`);
  console.log(`URL: ${page.url()}`);

  await page.waitForSelector(
    READY_SELECTOR,
    {
      visible: true,
      timeout: 60_000
    }
  );

  // Give the SPA a short chance to finish DOM mutations.
  await new Promise(
    resolve => setTimeout(resolve, 1500)
  );

  const snapshot = await page.evaluate(() => {
    const clone =
      document.documentElement.cloneNode(true);

    // Remove executable, embedded, hidden and irrelevant content.
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

    // Strip active/network-capable/suspicious attributes.
    for (const el of clone.querySelectorAll('*')) {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();

        if (networkAttrs.has(name)) {
          el.setAttribute(
            `data-original-${name}`,
            attr.value
          );
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

    const body = clone.querySelector('body');

    const text =
      (body?.textContent ?? '')
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n\s*\n+/g, '\n\n')
        .trim();

    return {
      title: document.title,
      url: location.href,
      html:
        '<!doctype html>\n' +
        clone.outerHTML,
      text
    };
  });

  const capturedAt = new Date().toISOString();

  const stamp =
    capturedAt.replace(/[:.]/g, '-');

  const snapshotDir =
    path.join(
      CACHE_DIR,
      'snapshots',
      stamp
    );

  await fs.mkdir(
    snapshotDir,
    { recursive: true }
  );

  const sha256 = value =>
    crypto
      .createHash('sha256')
      .update(value)
      .digest('hex');

  const metadata = {
    capturedAt,
    title: snapshot.title,
    url: snapshot.url,
    readySelector: READY_SELECTOR,

    sha256: {
      html: sha256(snapshot.html),
      text: sha256(snapshot.text)
    }
  };

  await Promise.all([
    fs.writeFile(
      path.join(snapshotDir, 'page.html'),
      snapshot.html,
      'utf8'
    ),

    fs.writeFile(
      path.join(snapshotDir, 'page.txt'),
      snapshot.text,
      'utf8'
    ),

    fs.writeFile(
      path.join(snapshotDir, 'metadata.json'),
      JSON.stringify(metadata, null, 2),
      'utf8'
    )
  ]);

  console.log('');
  console.log(`Snapshot: ${snapshotDir}`);
  console.log(`Text length: ${snapshot.text.length}`);
  console.log(`HTML length: ${snapshot.html.length}`);

} finally {
  // Leave authenticated Edge running.
  await browser.disconnect();
}