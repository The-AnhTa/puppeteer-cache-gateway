import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/*
 * ------------------------------------------------------------------
 * Configuration
 * ------------------------------------------------------------------
 */

const CDP_URL =
  process.env.CDP_URL ??
  'http://127.0.0.1:9222';

const TARGET_ORIGIN =
  process.env.TARGET_ORIGIN;

const READY_SELECTOR =
  process.env.READY_SELECTOR ??
  'body';

const CACHE_DIR =
  process.env.CACHE_DIR ??
  'C:\\agent-web-cache\\semsplus';

/*
 * TARGET_ORIGIN is deliberately supplied at runtime instead of being
 * hard-coded into the repository.
 */
if (!TARGET_ORIGIN) {
  throw new Error(
    'TARGET_ORIGIN is required, e.g. https://example.com'
  );
}

/*
 * ------------------------------------------------------------------
 * Connect to the already-running authenticated Edge browser.
 *
 * IMPORTANT:
 * Edge must already have been launched with:
 *
 *   --remote-debugging-address=127.0.0.1
 *   --remote-debugging-port=9222
 *   --user-data-dir=<dedicated profile>
 *
 * ------------------------------------------------------------------
 */

const browser = await puppeteer.connect({
  browserURL: CDP_URL
});

try {

  /*
   * ---------------------------------------------------------------
   * Find the already-open page belonging to TARGET_ORIGIN.
   *
   * We do NOT navigate here.
   * We do NOT enter credentials here.
   * We use the page that you authenticated manually in Edge.
   * ---------------------------------------------------------------
   */

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

  console.log(
    `Using page: ${await page.title()}`
  );

  console.log(
    `URL: ${page.url()}`
  );

  /*
   * ---------------------------------------------------------------
   * Wait for the page to be available.
   *
   * READY_SELECTOR=body is acceptable for our initial testing.
   *
   * Later we can replace this with a SEMS+-specific condition.
   * ---------------------------------------------------------------
   */

  await page.waitForSelector(
    READY_SELECTOR,
    {
      visible: true,
      timeout: 60_000
    }
  );

  /*
   * Temporary settling period for the SPA.
   *
   * Later we should replace this with a semantic readiness test.
   */
  await new Promise(
    resolve => setTimeout(resolve, 1500)
  );

  /*
   * ---------------------------------------------------------------
   * Snapshot and sanitize the rendered page.
   * ---------------------------------------------------------------
   */

  const snapshot =
    await page.evaluate(() => {

      /*
       * Clone the rendered DOM.
       *
       * We sanitize the clone rather than modifying the live SEMS+
       * page.
       */
      const clone =
        document.documentElement.cloneNode(true);

      /*
       * ------------------------------------------------------------
       * Remove HTML comments.
       *
       * This also removes things such as:
       *
       *   <!-- <script> ... -->
       *
       * even though comments are already inert.
       * ------------------------------------------------------------
       */

      const walker =
        document.createTreeWalker(
          clone,
          NodeFilter.SHOW_COMMENT
        );

      const comments = [];

      while (walker.nextNode()) {
        comments.push(
          walker.currentNode
        );
      }

      for (const comment of comments) {
        comment.remove();
      }

      /*
       * ------------------------------------------------------------
       * Remove executable, embedded, hidden, or unnecessary elements.
       * ------------------------------------------------------------
       */

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
      ).forEach(
        el => el.remove()
      );

      /*
       * ------------------------------------------------------------
       * Attributes capable of causing network requests or navigation.
       *
       * We remove them completely.
       *
       * We deliberately DO NOT preserve their original values in
       * data-original-* attributes because URLs may themselves
       * contain sensitive identifiers or tokens.
       * ------------------------------------------------------------
       */

      const networkAttrs =
        new Set([
          'src',
          'srcset',
          'poster',
          'href',
          'action',
          'formaction'
        ]);

      /*
       * Include the root <html> element itself as well as every
       * descendant.
       */

      const elements = [
        clone,
        ...clone.querySelectorAll('*')
      ];

      for (const el of elements) {

        for (
          const attr of [...el.attributes]
        ) {

          const name =
            attr.name.toLowerCase();

          /*
           * Remove normal network-capable attributes plus namespaced
           * href attributes such as:
           *
           *   xlink:href="..."
           *
           * commonly used inside SVG.
           */

          if (
            networkAttrs.has(name) ||
            name.endsWith(':href')
          ) {
            el.removeAttribute(
              attr.name
            );

            continue;
          }

          /*
           * Remove inline JavaScript event handlers, inline style,
           * srcdoc, and attributes whose names strongly suggest they
           * may contain authentication/session material.
           */

          if (
            name.startsWith('on') ||
            name === 'srcdoc' ||
            name === 'style' ||
            /(^|[-_:])(token|secret|password|passwd|auth|session|csrf)([-_:]|$)/i
              .test(name)
          ) {
            el.removeAttribute(
              attr.name
            );
          }
        }
      }

      /*
       * ------------------------------------------------------------
       * Generate human/LLM-friendly text.
       *
       * We intentionally use innerText from the rendered LIVE page.
       *
       * Therefore:
       *
       *   page.html = sanitized cloned DOM
       *   page.txt  = rendered visible text
       *
       * innerText provides much better logical line separation than
       * textContent for this SPA.
       * ------------------------------------------------------------
       */

      const text =
        (document.body?.innerText ?? '')
          .replace(
            /\u00a0/g,
            ' '
          )
          .split(
            /\r?\n/
          )
          .map(
            line =>
              line
                .replace(
                  /[ \t]+/g,
                  ' '
                )
                .trim()
          )
          .filter(
            Boolean
          )
          .join(
            '\n'
          );

      /*
       * Return the sanitized representations to Node.js.
       */

      return {
        title:
          document.title,

        url:
          location.href,

        html:
          '<!doctype html>\n' +
          clone.outerHTML,

        text
      };
    });

  /*
   * ---------------------------------------------------------------
   * Create an immutable timestamped snapshot.
   * ---------------------------------------------------------------
   */

  const capturedAt =
    new Date().toISOString();

  const stamp =
    capturedAt.replace(
      /[:.]/g,
      '-'
    );

  const snapshotDir =
    path.join(
      CACHE_DIR,
      'snapshots',
      stamp
    );

  await fs.mkdir(
    snapshotDir,
    {
      recursive: true
    }
  );

  /*
   * ---------------------------------------------------------------
   * SHA-256 helper.
   * ---------------------------------------------------------------
   */

  const sha256 =
    value =>
      crypto
        .createHash(
          'sha256'
        )
        .update(
          value
        )
        .digest(
          'hex'
        );

  /*
   * ---------------------------------------------------------------
   * Snapshot metadata.
   * ---------------------------------------------------------------
   */

  const metadata = {
    capturedAt,

    title:
      snapshot.title,

    url:
      snapshot.url,

    readySelector:
      READY_SELECTOR,

    sha256: {
      html:
        sha256(
          snapshot.html
        ),

      text:
        sha256(
          snapshot.text
        )
    }
  };

  /*
   * ---------------------------------------------------------------
   * Write all snapshot artifacts as UTF-8.
   * ---------------------------------------------------------------
   */

  await Promise.all([

    fs.writeFile(
      path.join(
        snapshotDir,
        'page.html'
      ),
      snapshot.html,
      'utf8'
    ),

    fs.writeFile(
      path.join(
        snapshotDir,
        'page.txt'
      ),
      snapshot.text,
      'utf8'
    ),

    fs.writeFile(
      path.join(
        snapshotDir,
        'metadata.json'
      ),
      JSON.stringify(
        metadata,
        null,
        2
      ),
      'utf8'
    )

  ]);

  /*
   * ---------------------------------------------------------------
   * Report successful capture.
   * ---------------------------------------------------------------
   */

  console.log('');

  console.log(
    `Snapshot: ${snapshotDir}`
  );

  console.log(
    `Text length: ${snapshot.text.length}`
  );

  console.log(
    `HTML length: ${snapshot.html.length}`
  );

} finally {

  /*
   * ---------------------------------------------------------------
   * IMPORTANT:
   *
   * disconnect() leaves the authenticated Edge browser running.
   *
   * Do NOT replace this with browser.close().
   * ---------------------------------------------------------------
   */

  await browser.disconnect();
}