import puppeteer from 'puppeteer-core';

/*
 * ================================================================
 * Restricted SEMS+ control interface
 *
 * This program deliberately does NOT accept arbitrary selectors.
 *
 * The caller may select ONLY a control explicitly defined in
 * ALLOWED_CONTROLS below.
 *
 * No goto()
 * No arbitrary click()
 * No form submission
 * No arbitrary JavaScript supplied by caller
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

if (!TARGET_ORIGIN) {
  throw new Error(
    'TARGET_ORIGIN is required'
  );
}

/*
 * ----------------------------------------------------------------
 * HARD ALLOWLIST
 * ----------------------------------------------------------------
 *
 * Only these controls may be clicked.
 *
 * Each entry specifies:
 *
 *   selector    exact DOM selector
 *   text        expected visible text
 *   nodeKey     expected SEMS+ data-node-key
 *
 * The script verifies all of these before clicking.
 */

const ALLOWED_CONTROLS = Object.freeze({

  dashboard: {
    selector:
      '#rc-tabs-0-tab-dashboard',

    text:
      'Dashboard',

    nodeKey:
      'dashboard'
  },

  devices: {
    selector:
      '#rc-tabs-0-tab-device_list',

    text:
      'Devices',

    nodeKey:
      'device_list'
  },

  alarms: {
    selector:
      '#rc-tabs-0-tab-alarm',

    text:
      'Alarms',

    nodeKey:
      'alarm'
  },

  powerCurve: {
    selector:
      '#rc-tabs-1-tab-power_chart',

    text:
      'Power Curve',

    nodeKey:
      'power_chart'
  },

  energyMonitoring: {
    selector:
      '#rc-tabs-1-tab-generate_flow_column',

    text:
      'Energy Monitoring',

    nodeKey:
      'generate_flow_column'
  },

  generationComparison: {
    selector:
      '#rc-tabs-1-tab-compare_chart',

    text:
      'Generation Comparison',

    nodeKey:
      'compare_chart'
  },

  heatmap: {
    selector:
      '#rc-tabs-1-tab-heatmap',

    text:
      'Heatmap',

    nodeKey:
      'heatmap'
  }

});

/*
 * ----------------------------------------------------------------
 * Command line
 * ----------------------------------------------------------------
 */

const requested =
  process.argv[2];

if (
  !requested ||
  requested === '--list'
) {

  console.log(
    'Allowed controls:'
  );

  console.log('');

  for (
    const [name, config]
    of Object.entries(ALLOWED_CONTROLS)
  ) {

    console.log(
      `${name.padEnd(22)} ${config.text}`
    );
  }

  process.exit(0);
}

/*
 * Reject anything not explicitly listed.
 */

const control =
  ALLOWED_CONTROLS[requested];

if (!control) {

  console.error(
    `DENIED: "${requested}" is not an allowed control.`
  );

  console.error('');

  console.error(
    'Run with --list to see allowed controls.'
  );

  process.exit(2);
}

/*
 * ----------------------------------------------------------------
 * Connect to authenticated Edge.
 * ----------------------------------------------------------------
 */

const browser =
  await puppeteer.connect({
    browserURL: CDP_URL
  });

try {

  const pages =
    await browser.pages();

  /*
   * Find the authenticated SEMS+ station-detail page.
   */

  const page =
    pages.find((p) => {

      try {

        const url =
          new URL(p.url());

        return (
          url.origin === TARGET_ORIGIN &&
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

  /*
   * ----------------------------------------------------------------
   * Security check #1:
   * verify origin before doing anything.
   * ----------------------------------------------------------------
   */

  const beforeUrl =
    new URL(page.url());

  if (
    beforeUrl.origin !== TARGET_ORIGIN
  ) {

    throw new Error(
      `Origin mismatch before click: ${beforeUrl.origin}`
    );
  }

  console.log(
    `Page: ${await page.title()}`
  );

  console.log(
    `URL:  ${page.url()}`
  );

  console.log('');

  console.log(
    `Requested control: ${requested}`
  );

  console.log(
    `Expected text:     ${control.text}`
  );

  console.log(
    `Selector:          ${control.selector}`
  );

  /*
   * ----------------------------------------------------------------
   * Wait only for the allowlisted selector.
   * ----------------------------------------------------------------
   */

  await page.waitForSelector(
    control.selector,
    {
      visible: true,
      timeout: 15_000
    }
  );

  /*
   * ----------------------------------------------------------------
   * Inspect the control BEFORE clicking.
   *
   * Verify:
   *
   *   role="tab"
   *   expected text
   *   expected data-node-key
   *
   * This protects against accidentally clicking a different element
   * if the website changes its DOM.
   * ----------------------------------------------------------------
   */

  const observed =
    await page.$eval(
      control.selector,
      (el) => {

        const parent =
          el.closest(
            '[data-node-key]'
          );

        return {

          text:
            (el.innerText ?? '')
              .replace(/\s+/g, ' ')
              .trim(),

          role:
            el.getAttribute(
              'role'
            ),

          ariaSelected:
            el.getAttribute(
              'aria-selected'
            ),

          nodeKey:
            el.getAttribute(
              'data-node-key'
            ) ??
            parent?.getAttribute(
              'data-node-key'
            ) ??
            null
        };
      }
    );

  console.log('');

  console.log(
    `Observed text:     ${observed.text}`
  );

  console.log(
    `Observed role:     ${observed.role}`
  );

  console.log(
    `Observed nodeKey:  ${observed.nodeKey}`
  );

  console.log(
    `Already selected:  ${observed.ariaSelected}`
  );

  /*
   * ----------------------------------------------------------------
   * Security check #2:
   * validate DOM identity.
   * ----------------------------------------------------------------
   */

  if (
    observed.role !== 'tab'
  ) {

    throw new Error(
      `DENIED: expected role="tab", got "${observed.role}"`
    );
  }

  if (
    observed.text !== control.text
  ) {

    throw new Error(
      `DENIED: expected text "${control.text}", ` +
      `got "${observed.text}"`
    );
  }

  if (
    observed.nodeKey !== control.nodeKey
  ) {

    throw new Error(
      `DENIED: expected nodeKey "${control.nodeKey}", ` +
      `got "${observed.nodeKey}"`
    );
  }

  /*
   * ----------------------------------------------------------------
   * If already selected, there is nothing to do.
   * ----------------------------------------------------------------
   */

  if (
    observed.ariaSelected === 'true'
  ) {

    console.log('');

    console.log(
      'Control is already selected.'
    );

    process.exitCode = 0;

  } else {

    /*
     * --------------------------------------------------------------
     * This is the ONLY click in this program.
     *
     * control.selector comes exclusively from ALLOWED_CONTROLS.
     *
     * The caller cannot provide an arbitrary CSS selector.
     * --------------------------------------------------------------
     */

    console.log('');

    console.log(
      `Clicking allowed control: ${requested}`
    );

    await page.click(
      control.selector
    );

    /*
     * --------------------------------------------------------------
     * Wait until SEMS+ reports this tab selected.
     * --------------------------------------------------------------
     */

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

    /*
     * Give the SPA a short opportunity to render the selected panel.
     *
     * Later this can be replaced with panel-specific readiness rules.
     */

    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          1500
        )
    );

    /*
     * --------------------------------------------------------------
     * Security check #3:
     * clicking a tab must not have navigated outside the approved
     * origin.
     * --------------------------------------------------------------
     */

    const afterUrl =
      new URL(
        page.url()
      );

    if (
      afterUrl.origin !== TARGET_ORIGIN
    ) {

      throw new Error(
        `DENIED: control caused navigation to ` +
        `${afterUrl.origin}`
      );
    }

    if (
      !page.url().includes(
        TARGET_URL_CONTAINS
      )
    ) {

      throw new Error(
        'DENIED: station-detail context changed unexpectedly'
      );
    }

    /*
     * --------------------------------------------------------------
     * Verify the selected state one final time.
     * --------------------------------------------------------------
     */

    const selected =
      await page.$eval(
        control.selector,
        el =>
          el.getAttribute(
            'aria-selected'
          )
      );

    if (
      selected !== 'true'
    ) {

      throw new Error(
        'Control did not become selected'
      );
    }

    console.log('');

    console.log(
      'SUCCESS'
    );

    console.log(
      `Selected: ${control.text}`
    );

    console.log(
      `URL:      ${page.url()}`
    );
  }

} finally {

  /*
   * Leave authenticated Edge running.
   */

  await browser.disconnect();
}