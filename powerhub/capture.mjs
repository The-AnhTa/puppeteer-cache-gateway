import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  pathToFileURL
} from 'node:url';

import {
  connectToPowerhub
} from './cdp.mjs';
import {
  POWERHUB_GROUP_ID,
  POWERHUB_ORIGIN,
  POWERHUB_ROUTES,
  assertAllowedNavigation,
  assertCapturedLocation
} from './routes.mjs';
import {
  buildSanitizeExpression
} from './sanitize.mjs';

const CACHE_DIR =
  process.env.POWERHUB_CACHE_DIR ??
  'C:\\agent-web-cache\\tesla-powerhub';

const SETTLE_MS =
  Number.parseInt(
    process.env.POWERHUB_SETTLE_MS ?? '2000',
    10
  );

if (
  !Number.isInteger(SETTLE_MS) ||
  SETTLE_MS < 500 ||
  SETTLE_MS > 60_000
) {
  throw new Error(
    'POWERHUB_SETTLE_MS must be between 500 and 60000'
  );
}

const delay = milliseconds =>
  new Promise(resolve => {
    setTimeout(resolve, milliseconds);
  });

function sha256(value) {
  return crypto
    .createHash('sha256')
    .update(value)
    .digest('hex');
}

async function evaluate(
  client,
  expression
) {
  const response =
    await client.command(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: true,
        awaitPromise: true
      }
    );

  if (response.exceptionDetails) {
    throw new Error(
      'Powerhub page evaluation failed'
    );
  }

  return response.result?.value;
}

async function waitForDocumentReady(client) {
  const deadline =
    Date.now() + 60_000;

  while (Date.now() < deadline) {
    const state =
      await evaluate(
        client,
        `({
          readyState: document.readyState,
          origin: location.origin
        })`
      );

    if (state.origin !== POWERHUB_ORIGIN) {
      throw new Error(
        'DENIED: navigation left the Powerhub origin'
      );
    }

    if (
      state.readyState === 'interactive' ||
      state.readyState === 'complete'
    ) {
      return;
    }

    await delay(250);
  }

  throw new Error(
    'Timed out waiting for the Powerhub document'
  );
}

async function waitForRoute(
  client,
  route
) {
  const deadline =
    Date.now() + 60_000;

  while (Date.now() < deadline) {
    try {
      const location =
        await evaluate(
          client,
          `({
            origin: location.origin,
            href: location.href
          })`
        );

      if (location.origin !== POWERHUB_ORIGIN) {
        throw new Error(
          'DENIED: navigation left the Powerhub origin'
        );
      }

      if (location.href === route.url) {
        return;
      }
    } catch (error) {
      if (
        String(error.message).startsWith('DENIED:')
      ) {
        throw error;
      }
    }

    await delay(250);
  }

  throw new Error(
    `Timed out waiting for ${route.label}`
  );
}

async function waitForSpaToSettle(client) {
  await delay(SETTLE_MS);

  const deadline =
    Date.now() + 20_000;
  let previous;
  let stableCount = 0;

  while (Date.now() < deadline) {
    const state =
      await evaluate(
        client,
        `({
          origin: location.origin,
          href: location.href,
          readyState: document.readyState,
          textLength: document.body?.innerText?.length ?? 0,
          elementCount: document.body?.getElementsByTagName('*').length ?? 0
        })`
      );

    if (state.origin !== POWERHUB_ORIGIN) {
      throw new Error(
        'DENIED: the Powerhub SPA left its approved origin'
      );
    }

    const signature =
      JSON.stringify(state);

    if (signature === previous) {
      stableCount += 1;

      if (stableCount >= 2) {
        return;
      }
    } else {
      previous = signature;
      stableCount = 0;
    }

    await delay(750);
  }

  throw new Error(
    'Timed out waiting for the Powerhub SPA to settle'
  );
}

async function writeRouteCapture(
  runDir,
  route,
  capture
) {
  const routeDir =
    path.join(
      runDir,
      route.key
    );

  await fs.mkdir(
    routeDir,
    { recursive: true }
  );

  const screenshot =
    Buffer.from(
      capture.screenshot,
      'base64'
    );

  const metadata = {
    route: route.key,
    label: route.label,
    source_url: route.url,
    title: capture.title,
    captured_at: capture.capturedAt,
    sha256: {
      html: sha256(capture.html),
      text: sha256(capture.text),
      screenshot: sha256(screenshot)
    }
  };

  await Promise.all([
    fs.writeFile(
      path.join(routeDir, 'page.html'),
      capture.html,
      'utf8'
    ),
    fs.writeFile(
      path.join(routeDir, 'page.txt'),
      capture.text,
      'utf8'
    ),
    fs.writeFile(
      path.join(routeDir, 'screenshot.png'),
      screenshot
    ),
    fs.writeFile(
      path.join(routeDir, 'metadata.json'),
      `${JSON.stringify(metadata, null, 2)}\n`,
      'utf8'
    )
  ]);

  return {
    key: route.key,
    label: route.label,
    path: route.path,
    captured_at: capture.capturedAt,
    files: [
      'page.html',
      'page.txt',
      'screenshot.png',
      'metadata.json'
    ]
  };
}

async function captureRoute(
  client,
  route
) {
  const url =
    assertAllowedNavigation(route.url);

  const navigation =
    await client.command(
      'Page.navigate',
      { url }
    );

  if (navigation.errorText) {
    throw new Error(
      `Powerhub navigation failed for ${route.label}`
    );
  }

  await waitForRoute(
    client,
    route
  );
  await waitForDocumentReady(client);
  await waitForSpaToSettle(client);

  const location =
    await evaluate(
      client,
      'location.href'
    );

  assertCapturedLocation(
    location,
    route
  );

  const snapshot =
    await evaluate(
      client,
      buildSanitizeExpression()
    );

  if (
    !snapshot ||
    typeof snapshot.html !== 'string' ||
    typeof snapshot.text !== 'string'
  ) {
    throw new Error(
      `Powerhub returned an invalid snapshot for ${route.label}`
    );
  }

  const screenshot =
    await client.command(
      'Page.captureScreenshot',
      {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false
      }
    );

  if (!screenshot.data) {
    throw new Error(
      `Powerhub returned no screenshot for ${route.label}`
    );
  }

  return {
    ...snapshot,
    screenshot: screenshot.data,
    capturedAt: new Date().toISOString()
  };
}

export async function capturePowerhub() {
  const capturedAt =
    new Date().toISOString();
  const stamp =
    capturedAt.replace(/[:.]/g, '-');
  const runDir =
    path.resolve(
      CACHE_DIR,
      'snapshots',
      stamp
    );

  await fs.mkdir(
    runDir,
    { recursive: true }
  );

  const client =
    await connectToPowerhub();

  const manifest = {
    site: 'Tesla Powerhub',
    origin: POWERHUB_ORIGIN,
    group_id: POWERHUB_GROUP_ID,
    captured_at: capturedAt,
    routes: [],
    authenticated_source: true,
    credentials_captured: false,
    network_required_for_replay: false
  };

  try {
    await client.command('Page.enable');
    await client.command('Runtime.enable');

    for (const route of POWERHUB_ROUTES) {
      console.log(
        `Capturing ${route.label}...`
      );

      const capture =
        await captureRoute(
          client,
          route
        );

      manifest.routes.push(
        await writeRouteCapture(
          runDir,
          route,
          capture
        )
      );
    }

    await fs.writeFile(
      path.join(runDir, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8'
    );

    await fs.mkdir(
      CACHE_DIR,
      { recursive: true }
    );

    await fs.writeFile(
      path.join(CACHE_DIR, 'latest.json'),
      `${JSON.stringify({
        snapshot: stamp,
        captured_at: capturedAt
      }, null, 2)}\n`,
      'utf8'
    );

    console.log('');
    console.log('POWERHUB CAPTURE COMPLETE');
    console.log(`Snapshot: ${runDir}`);
    console.log(`Routes: ${manifest.routes.length}`);

    return runDir;
  } finally {
    await client.detach();
  }
}

if (
  process.argv[1] &&
  pathToFileURL(
    path.resolve(process.argv[1])
  ).href === import.meta.url
) {
  await capturePowerhub();
}
