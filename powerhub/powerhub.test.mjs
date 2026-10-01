import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildReplay
} from './build-replay.mjs';
import {
  POWERHUB_GROUP_ID,
  POWERHUB_ORIGIN,
  POWERHUB_ROUTES,
  assertAllowedNavigation
} from './routes.mjs';
import {
  validateReplay
} from './validate-replay.mjs';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

async function makeFixture() {
  const cacheDir =
    await fs.mkdtemp(
      path.join(
        os.tmpdir(),
        'powerhub-replay-test-'
      )
    );
  const stamp =
    '2026-01-02T03-04-05-000Z';
  const snapshotDir =
    path.join(
      cacheDir,
      'snapshots',
      stamp
    );
  const capturedAt =
    '2026-01-02T03:04:05.000Z';

  await fs.mkdir(
    snapshotDir,
    { recursive: true }
  );

  const manifest = {
    site: 'Tesla Powerhub',
    origin: POWERHUB_ORIGIN,
    group_id: POWERHUB_GROUP_ID,
    captured_at: capturedAt,
    routes: POWERHUB_ROUTES.map(route => ({
      key: route.key,
      label: route.label,
      path: route.path,
      captured_at: capturedAt
    })),
    authenticated_source: true,
    credentials_captured: false,
    network_required_for_replay: false
  };

  for (const route of POWERHUB_ROUTES) {
    const routeDir =
      path.join(
        snapshotDir,
        route.key
      );

    await fs.mkdir(
      routeDir,
      { recursive: true }
    );

    await Promise.all([
      fs.writeFile(
        path.join(routeDir, 'page.html'),
        `<!doctype html><html><body><main>${route.label} fixture</main></body></html>`,
        'utf8'
      ),
      fs.writeFile(
        path.join(routeDir, 'page.txt'),
        `${route.label}\nCaptured local state`,
        'utf8'
      ),
      fs.writeFile(
        path.join(routeDir, 'screenshot.png'),
        ONE_PIXEL_PNG
      ),
      fs.writeFile(
        path.join(routeDir, 'metadata.json'),
        JSON.stringify({
          route: route.key,
          source_url: route.url
        }),
        'utf8'
      )
    ]);
  }

  await Promise.all([
    fs.writeFile(
      path.join(snapshotDir, 'manifest.json'),
      JSON.stringify(manifest),
      'utf8'
    ),
    fs.writeFile(
      path.join(cacheDir, 'latest.json'),
      JSON.stringify({
        snapshot: stamp,
        captured_at: capturedAt
      }),
      'utf8'
    )
  ]);

  return cacheDir;
}

test(
  'navigation accepts only the five exact read-only routes',
  () => {
    for (const route of POWERHUB_ROUTES) {
      assert.equal(
        assertAllowedNavigation(route.url),
        route.url
      );
    }

    assert.throws(
      () => assertAllowedNavigation(
        `${POWERHUB_ORIGIN}/logout`
      ),
      /DENIED/
    );
    assert.throws(
      () => assertAllowedNavigation(
        `${POWERHUB_ROUTES[0].url}?action=edit`
      ),
      /DENIED/
    );
    assert.throws(
      () => assertAllowedNavigation(
        'https://www.mapbox.com/'
      ),
      /DENIED/
    );
  }
);

test(
  'fixture build produces a network-independent validated replay',
  async t => {
    const cacheDir =
      await makeFixture();

    t.after(async () => {
      await fs.rm(
        cacheDir,
        {
          recursive: true,
          force: true
        }
      );
    });

    const replayDir =
      await buildReplay({ cacheDir });
    const result =
      await validateReplay(replayDir);

    assert.ok(result.files >= 13);

    const mapPage =
      await fs.readFile(
        path.join(replayDir, 'map.html'),
        'utf8'
      );
    const graphingPage =
      await fs.readFile(
        path.join(replayDir, 'graphing.html'),
        'utf8'
      );

    assert.match(
      mapPage,
      /assets\/map\.png/
    );
    assert.match(
      graphingPage,
      /assets\/graphing\.png/
    );
    assert.match(
      mapPage,
      /connect-src 'none'/
    );
  }
);

test(
  'validator rejects browser network APIs',
  async t => {
    const cacheDir =
      await makeFixture();

    t.after(async () => {
      await fs.rm(
        cacheDir,
        {
          recursive: true,
          force: true
        }
      );
    });

    const replayDir =
      await buildReplay({ cacheDir });

    await fs.appendFile(
      path.join(replayDir, 'overview.html'),
      '<script>fetch("/forbidden")</script>',
      'utf8'
    );

    await assert.rejects(
      validateReplay(replayDir),
      /contains fetch\(/
    );
  }
);
