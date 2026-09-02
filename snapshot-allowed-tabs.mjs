import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/*
 * ================================================================
 * Trusted SEMS+ multi-tab snapshot collector
 *
 * - Connects only to the existing authenticated Edge instance.
 * - Does not navigate to arbitrary URLs.
 * - Does not accept arbitrary selectors.
 * - Clicks only controls hard-coded below.
 * - Sanitizes each rendered view before writing it to cache.
 * - Updates latest.json only after the whole run succeeds.
 * ================================================================
 */

const CDP_URL =
  process.env.CDP_URL ??
  'http://127.0.0.1:9222';

const TARGET_ORIGIN =
  process.env.TARGET_ORIGIN;

const TARGET_URL_CONTAINS =
  process.env.TARGET_URL_CONTAINS ??
  'station_monitor/station_detail';

const CACHE_DIR =
  process.env.CACHE_DIR ??
  'C:\\agent-web-cache\\semsplus';

const SETTLE_MS =
  Number(process.env.SETTLE_MS ?? '2000');

if (!TARGET_ORIGIN) {
  throw new Error(
    'TARGET_ORIGIN is required'
  );
}

/*
 * ---------------------------------------------------------------
 * Hard allowlist.
 *
 * Use semantic data-node-key values rather than generated rc-tabs-N
 * IDs where possible.
 * ---------------------------------------------------------------
 */

const CONTROLS = Object.freeze({

  dashboard: {
    selector:
      '[data-node-key="dashboard"] > [role="tab"]',
    text:
      'Dashboard',
    nodeKey:
      'dashboard',
    slug:
      'dashboard'
  },

  devices: {
    selector:
      '[data-node-key="device_list"] > [role="tab"]',
    text:
      'Devices',
    nodeKey:
      'device_list',
    slug:
      'devices'
  },

  alarms: {
    selector:
      '[data-node-key="alarm"] > [role="tab"]',
    text:
      'Alarms',
    nodeKey:
      'alarm',
    slug:
      'alarms'
  },

  powerCurve: {
    selector:
      '[data-node-key="power_chart"] > [role="tab"]',
    text:
      'Power Curve',
    nodeKey:
      'power_chart',
    slug:
      'power-curve'
  },

  energyMonitoring: {
    selector:
      '[data-node-key="generate_flow_column"] > [role="tab"]',
    text:
      'Energy Monitoring',
    nodeKey:
      'generate_flow_column',
    slug:
      'energy-monitoring'
  },

  generationComparison: {
    selector:
      '[data-node-key="compare_chart"] > [role="tab"]',
    text:
      'Generation Comparison',
    nodeKey:
      'compare_chart',
    slug:
      'generation-comparison'
  },

  heatmap: {
    selector:
      '[data-node-key="heatmap"] > [role="tab"]',
    text:
      'Heatmap',
    nodeKey:
      'heatmap',
    slug:
      'heatmap'
  }

});

/*
 * ---------------------------------------------------------------
 * SHA-256 helper.
 * ---------------------------------------------------------------
 */

function sha256(value) {
  return crypto
    .createHash('sha256')
    .update(value)
    .digest('hex');
}

/*
 * ---------------------------------------------------------------
 * Verify that Puppeteer is still operating on the expected page.
 * ---------------------------------------------------------------
 */

function verifyPageLocation(page) {
  const url =
    new URL(page.url());

  if (url.origin !== TARGET_ORIGIN) {
    throw new Error(
      `Origin changed unexpectedly: ${url.origin}`
    );
  }

  if (
    !page.url().includes(
      TARGET_URL_CONTAINS
    )
  ) {
    throw new Error(
      'Station-detail context changed unexpectedly'
    );
  }
}

/*
 * ---------------------------------------------------------------
 * Strict allowlisted click.
 * ---------------------------------------------------------------
 */

async function selectControl(
  page,
  controlName
) {
  const control =
    CONTROLS[controlName];

  if (!control) {
    throw new Error(
      `Internal error: unapproved control ${controlName}`
    );
  }

  verifyPageLocation(page);

  await page.waitForSelector(
    control.selector,
    {
      visible: true,
      timeout: 15_000
    }
  );

  const observed =
    await page.$eval(
      control.selector,
      (el) => {
        const parent =
          el.closest('[data-node-key]');

        return {
          text:
            (el.innerText ?? '')
              .replace(/\s+/g, ' ')
              .trim(),

          role:
            el.getAttribute('role'),

          nodeKey:
            el.getAttribute(
              'data-node-key'
            ) ??
            parent?.getAttribute(
              'data-node-key'
            ) ??
            null,

          ariaSelected:
            el.getAttribute(
              'aria-selected'
            )
        };
      }
    );

  if (observed.role !== 'tab') {
    throw new Error(
      `${controlName}: expected role="tab", got "${observed.role}"`
    );
  }

  if (
    observed.text !==
    control.text
  ) {
    throw new Error(
      `${controlName}: expected text "${control.text}", ` +
      `got "${observed.text}"`
    );
  }

  if (
    observed.nodeKey !==
    control.nodeKey
  ) {
    throw new Error(
      `${controlName}: expected nodeKey "${control.nodeKey}", ` +
      `got "${observed.nodeKey}"`
    );
  }

  if (
    observed.ariaSelected !== 'true'
  ) {
    console.log(
      `Selecting: ${control.text}`
    );

    await page.click(
      control.selector
    );

    await page.waitForFunction(
      (selector) => {
        const el =
          document.querySelector(
            selector
          );

        return (
          el?.getAttribute(
            'aria-selected'
          ) === 'true'
        );
      },
      {
        timeout: 15_000
      },
      control.selector
    );
  } else {
    console.log(
      `Already selected: ${control.text}`
    );
  }

  /*
   * Allow the SPA to load/render the selected view.
   *
   * Network idle is best-effort because this type of application
   * may poll continuously.
   */
  try {
    await page.waitForNetworkIdle({
      idleTime: 500,
      timeout: 4000
    });
  } catch {
    // Expected for SPAs that continuously poll.
  }

  await new Promise(
    resolve =>
      setTimeout(
        resolve,
        SETTLE_MS
      )
  );

  verifyPageLocation(page);

  const finalSelected =
    await page.$eval(
      control.selector,
      el =>
        el.getAttribute(
          'aria-selected'
        )
    );

  if (
    finalSelected !== 'true'
  ) {
    throw new Error(
      `${controlName}: tab did not remain selected`
    );
  }
}

/*
 * ---------------------------------------------------------------
 * Capture and sanitize the currently rendered page.
 * ---------------------------------------------------------------
 */

async function capturePage(page) {
  return await page.evaluate(() => {

    const clone =
      document.documentElement
        .cloneNode(true);

    /*
     * Remove HTML comments.
     */

    const walker =
      document.createTreeWalker(
        clone,
        NodeFilter.SHOW_COMMENT
      );

    const comments = [];

    while (
      walker.nextNode()
    ) {
      comments.push(
        walker.currentNode
      );
    }

    for (
      const comment of comments
    ) {
      comment.remove();
    }

    /*
     * Remove executable / embedded / hidden content.
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

    const networkAttrs =
      new Set([
        'src',
        'srcset',
        'poster',
        'href',
        'action',
        'formaction'
      ]);

    const elements = [
      clone,
      ...clone.querySelectorAll('*')
    ];

    for (
      const el of elements
    ) {
      for (
        const attr of
        [...el.attributes]
      ) {
        const name =
          attr.name.toLowerCase();

        /*
         * Remove network-capable attributes,
         * including SVG xlink:href.
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
         * Remove event handlers and suspicious attributes.
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
     * Human/LLM-readable visible text.
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
        .filter(Boolean)
        .join('\n');

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
}

/*
 * ---------------------------------------------------------------
 * Write one named snapshot.
 * ---------------------------------------------------------------
 */

async function writeSnapshot(
  runDir,
  controlName,
  snapshot
) {
  const control =
    CONTROLS[controlName];

  const metadata = {
    control:
      controlName,

    label:
      control.text,

    capturedAt:
      new Date().toISOString(),

    title:
      snapshot.title,

    url:
      snapshot.url,

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

  await Promise.all([

    fs.writeFile(
      path.join(
        runDir,
        `${control.slug}.html`
      ),
      snapshot.html,
      'utf8'
    ),

    fs.writeFile(
      path.join(
        runDir,
        `${control.slug}.txt`
      ),
      snapshot.text,
      'utf8'
    ),

    fs.writeFile(
      path.join(
        runDir,
        `${control.slug}.json`
      ),
      JSON.stringify(
        metadata,
        null,
        2
      ),
      'utf8'
    )

  ]);

  return metadata;
}

/*
 * ================================================================
 * Main run
 * ================================================================
 */

const browser =
  await puppeteer.connect({
    browserURL: CDP_URL
  });

try {

  const pages =
    await browser.pages();

  const page =
    pages.find((p) => {
      try {
        const url =
          new URL(p.url());

        return (
          url.origin ===
            TARGET_ORIGIN &&
          p.url().includes(
            TARGET_URL_CONTAINS
          )
        );
      } catch {
        return false;
      }
    });

  if (!page) {
    throw new Error(
      'Authenticated SEMS+ station-detail page not found'
    );
  }

  verifyPageLocation(page);

  console.log(
    `Page: ${await page.title()}`
  );

  console.log(
    `URL:  ${page.url()}`
  );

  console.log('');

  const startedAt =
    new Date().toISOString();

  const stamp =
    startedAt.replace(
      /[:.]/g,
      '-'
    );

  const runDir =
    path.join(
      CACHE_DIR,
      'collections',
      stamp
    );

  await fs.mkdir(
    runDir,
    {
      recursive: true
    }
  );

  const manifest = {
    startedAt,
    completedAt:
      null,

    origin:
      TARGET_ORIGIN,

    views:
      []
  };

  /*
   * ---------------------------------------------------------------
   * Collection sequence.
   *
   * Dashboard must remain active while accessing chart tabs.
   * ---------------------------------------------------------------
   */

  await selectControl(
    page,
    'dashboard'
  );

  /*
   * Put Dashboard into a deterministic chart state.
   */
  await selectControl(
    page,
    'powerCurve'
  );

  /*
   * Dashboard snapshot.
   *
   * This represents Dashboard with Power Curve selected.
   */
  {
    console.log(
      'Capturing: Dashboard'
    );

    const snapshot =
      await capturePage(page);

    manifest.views.push(
      await writeSnapshot(
        runDir,
        'dashboard',
        snapshot
      )
    );
  }

  /*
   * Power Curve.
   *
   * This overlaps with Dashboard by design because Power Curve is
   * embedded inside Dashboard.
   */
  {
    console.log(
      'Capturing: Power Curve'
    );

    const snapshot =
      await capturePage(page);

    manifest.views.push(
      await writeSnapshot(
        runDir,
        'powerCurve',
        snapshot
      )
    );
  }

  /*
   * Energy Monitoring.
   */
  await selectControl(
    page,
    'energyMonitoring'
  );

  {
    console.log(
      'Capturing: Energy Monitoring'
    );

    const snapshot =
      await capturePage(page);

    manifest.views.push(
      await writeSnapshot(
        runDir,
        'energyMonitoring',
        snapshot
      )
    );
  }

  /*
   * Generation Comparison.
   */
  await selectControl(
    page,
    'generationComparison'
  );

  {
    console.log(
      'Capturing: Generation Comparison'
    );

    const snapshot =
      await capturePage(page);

    manifest.views.push(
      await writeSnapshot(
        runDir,
        'generationComparison',
        snapshot
      )
    );
  }

  /*
   * Heatmap.
   */
  await selectControl(
    page,
    'heatmap'
  );

  {
    console.log(
      'Capturing: Heatmap'
    );

    const snapshot =
      await capturePage(page);

    manifest.views.push(
      await writeSnapshot(
        runDir,
        'heatmap',
        snapshot
      )
    );
  }

  /*
   * Devices top-level tab.
   */
  await selectControl(
    page,
    'devices'
  );

  {
    console.log(
      'Capturing: Devices'
    );

    const snapshot =
      await capturePage(page);

    manifest.views.push(
      await writeSnapshot(
        runDir,
        'devices',
        snapshot
      )
    );
  }

  /*
   * Alarms top-level tab.
   */
  await selectControl(
    page,
    'alarms'
  );

  {
    console.log(
      'Capturing: Alarms'
    );

    const snapshot =
      await capturePage(page);

    manifest.views.push(
      await writeSnapshot(
        runDir,
        'alarms',
        snapshot
      )
    );
  }

  /*
   * ---------------------------------------------------------------
   * The entire collection succeeded.
   * ---------------------------------------------------------------
   */

  manifest.completedAt =
    new Date().toISOString();

  await fs.writeFile(
    path.join(
      runDir,
      'manifest.json'
    ),
    JSON.stringify(
      manifest,
      null,
      2
    ),
    'utf8'
  );

  /*
   * ---------------------------------------------------------------
   * Update latest.json only after every view has been successfully
   * collected.
   * ---------------------------------------------------------------
   */

  await fs.mkdir(
    CACHE_DIR,
    {
      recursive: true
    }
  );

  const latestTmp =
    path.join(
      CACHE_DIR,
      'latest.json.tmp'
    );

  const latestPath =
    path.join(
      CACHE_DIR,
      'latest.json'
    );

  await fs.writeFile(
    latestTmp,
    JSON.stringify(
      {
        collection:
          stamp,

        completedAt:
          manifest.completedAt
      },
      null,
      2
    ),
    'utf8'
  );

  await fs.rm(
    latestPath,
    {
      force: true
    }
  );

  await fs.rename(
    latestTmp,
    latestPath
  );

  console.log('');
  console.log(
    'COLLECTION SUCCESS'
  );

  console.log(
    `Directory: ${runDir}`
  );

  console.log(
    `Views: ${manifest.views.length}`
  );

} finally {

  /*
   * Never terminate the authenticated Edge instance.
   */
  await browser.disconnect();
}