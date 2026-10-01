import fs from 'node:fs/promises';
import path from 'node:path';
import {
  pathToFileURL
} from 'node:url';

import {
  POWERHUB_GROUP_ID,
  POWERHUB_ORIGIN,
  POWERHUB_ROUTES
} from './routes.mjs';
import {
  validateReplay
} from './validate-replay.mjs';

const DEFAULT_CACHE_DIR =
  process.env.POWERHUB_CACHE_DIR ??
  'C:\\agent-web-cache\\tesla-powerhub';

const CSP = [
  "default-src 'self'",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "img-src 'self' data:",
  "script-src 'none'",
  "style-src 'self'",
  "font-src 'none'",
  "media-src 'none'"
].join('; ');

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function assertDirectChild(
  parent,
  child
) {
  const resolvedParent =
    path.resolve(parent);
  const resolvedChild =
    path.resolve(child);

  if (
    path.dirname(resolvedChild) !== resolvedParent ||
    resolvedChild === resolvedParent
  ) {
    throw new Error(
      'Refusing filesystem operation outside the Powerhub replay directory'
    );
  }

  return resolvedChild;
}

function renderHead(title) {
  return `
    <meta charset="utf-8">
    <meta
      http-equiv="Content-Security-Policy"
      content="${CSP}"
    >
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="./styles.css">
  `;
}

function renderNavigation(currentKey) {
  return POWERHUB_ROUTES
    .map(route => {
      const current =
        route.key === currentKey;

      return `
        <a
          class="nav-link${current ? ' active' : ''}"
          href="./${route.key}.html"
          ${current ? 'aria-current="page"' : ''}
        >${escapeHtml(route.label)}</a>
      `;
    })
    .join('\n');
}

function renderShell({
  title,
  currentKey,
  body
}) {
  return `<!doctype html>
<html lang="en">
  <head>${renderHead(title)}</head>
  <body>
    <header>
      <div>
        <p class="eyebrow">Tesla Powerhub</p>
        <h1>${escapeHtml(title)}</h1>
      </div>
      <span class="offline-badge">Offline snapshot</span>
    </header>
    <nav aria-label="Captured Powerhub routes">
      <a class="nav-link${currentKey ? '' : ' active'}" href="./index.html"${currentKey ? '' : ' aria-current="page"'}>Home</a>
      ${renderNavigation(currentKey)}
    </nav>
    <main>${body}</main>
  </body>
</html>
`;
}

function renderRoutePage(
  route,
  capture,
  capturedAt
) {
  const isVisualRoute =
    route.key === 'map' ||
    route.key === 'graphing';

  return renderShell({
    title: route.label,
    currentKey: route.key,
    body: `
      <section class="notice" aria-label="Replay status">
        <strong>Local replay only.</strong>
        This page cannot connect to Tesla, map providers, or any other service.
      </section>
      <dl class="metadata">
        <div><dt>Captured</dt><dd>${escapeHtml(capturedAt)}</dd></div>
        <div><dt>Route</dt><dd>${escapeHtml(route.label)}</dd></div>
      </dl>
      <section aria-labelledby="visual-heading">
        <h2 id="visual-heading">${isVisualRoute ? 'Required static visual capture' : 'Static visual capture'}</h2>
        <figure class="screenshot-frame">
          <img
            src="./assets/${route.key}.png"
            alt="Captured ${escapeHtml(route.label)} screen"
          >
          <figcaption>No live controls or network-backed content are present.</figcaption>
        </figure>
      </section>
      <section aria-labelledby="text-heading">
        <h2 id="text-heading">Visible text</h2>
        <pre class="captured-text">${escapeHtml(capture.text)}</pre>
      </section>
      <details>
        <summary>Sanitized DOM representation</summary>
        <pre class="captured-dom">${escapeHtml(capture.html)}</pre>
      </details>
    `
  });
}

function renderIndex(capturedAt) {
  const cards =
    POWERHUB_ROUTES
      .map(route => `
        <a class="route-card" href="./${route.key}.html">
          <h2>${escapeHtml(route.label)}</h2>
          <p>Open the captured local view.</p>
        </a>
      `)
      .join('\n');

  return renderShell({
    title: 'Offline replay',
    currentKey: undefined,
    body: `
      <section class="notice">
        <strong>Network-independent replay.</strong>
        Navigation and content stay entirely within this directory.
      </section>
      <p>Snapshot captured ${escapeHtml(capturedAt)}.</p>
      <div class="route-grid">${cards}</div>
    `
  });
}

function renderCss() {
  return `
:root {
  color-scheme: light dark;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  line-height: 1.5;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  color: #ececec;
  background: #111;
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 1.25rem clamp(1rem, 4vw, 3rem);
  border-bottom: 1px solid #393939;
}

h1, h2, p { margin-top: 0; }

.eyebrow {
  margin-bottom: .25rem;
  color: #aaa;
  font-size: .78rem;
  font-weight: 700;
  letter-spacing: .12em;
  text-transform: uppercase;
}

.offline-badge {
  border: 1px solid #777;
  border-radius: 999px;
  padding: .35rem .7rem;
  white-space: nowrap;
}

nav {
  display: flex;
  flex-wrap: wrap;
  gap: .5rem;
  padding: .8rem clamp(1rem, 4vw, 3rem);
  border-bottom: 1px solid #393939;
}

.nav-link,
.route-card {
  color: inherit;
  text-decoration: none;
}

.nav-link {
  border: 1px solid #555;
  border-radius: .35rem;
  padding: .4rem .7rem;
}

.nav-link.active {
  border-color: #eee;
  background: #2b2b2b;
  font-weight: 700;
}

main {
  width: min(100% - 2rem, 1200px);
  margin: 0 auto;
  padding: 1.5rem 0 3rem;
}

.notice,
.metadata,
.route-card,
.screenshot-frame,
.captured-text,
.captured-dom,
details {
  border: 1px solid #3d3d3d;
  border-radius: .5rem;
  background: #1a1a1a;
}

.notice { padding: .85rem 1rem; margin-bottom: 1rem; }

.metadata {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem 2rem;
  padding: .75rem 1rem;
}

.metadata div { display: flex; gap: .5rem; }
.metadata dt { font-weight: 700; }
.metadata dd { margin: 0; }

.route-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 1rem;
}

.route-card { display: block; padding: 1rem; }
.route-card:hover { border-color: #eee; }
.route-card p { margin-bottom: 0; color: #bbb; }

section, details { margin-top: 1.5rem; }

.screenshot-frame { margin: 0; padding: .75rem; }
.screenshot-frame img { display: block; width: 100%; height: auto; }
.screenshot-frame figcaption { padding-top: .65rem; color: #aaa; }

.captured-text,
.captured-dom {
  max-height: 36rem;
  overflow: auto;
  padding: 1rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

details { padding: .85rem 1rem; }
details summary { cursor: pointer; font-weight: 700; }
  `.trimStart();
}

async function loadSnapshot(cacheDir) {
  const latest = JSON.parse(
    await fs.readFile(
      path.join(cacheDir, 'latest.json'),
      'utf8'
    )
  );

  if (
    typeof latest.snapshot !== 'string' ||
    !/^[A-Za-z0-9._-]+$/.test(latest.snapshot) ||
    latest.snapshot === '.' ||
    latest.snapshot === '..'
  ) {
    throw new Error(
      'Invalid Powerhub snapshot name in latest.json'
    );
  }

  const snapshotsRoot =
    path.resolve(cacheDir, 'snapshots');
  const snapshotDir =
    assertDirectChild(
      snapshotsRoot,
      path.join(
        snapshotsRoot,
        latest.snapshot
      )
    );

  const manifest = JSON.parse(
    await fs.readFile(
      path.join(snapshotDir, 'manifest.json'),
      'utf8'
    )
  );

  if (
    manifest.site !== 'Tesla Powerhub' ||
    manifest.origin !== POWERHUB_ORIGIN ||
    manifest.group_id !== POWERHUB_GROUP_ID ||
    manifest.authenticated_source !== true ||
    manifest.credentials_captured !== false ||
    manifest.network_required_for_replay !== false
  ) {
    throw new Error(
      'Powerhub snapshot manifest failed its security checks'
    );
  }

  if (
    typeof manifest.captured_at !== 'string' ||
    !Number.isFinite(
      Date.parse(manifest.captured_at)
    ) ||
    !Array.isArray(manifest.routes) ||
    manifest.routes.length !== POWERHUB_ROUTES.length
  ) {
    throw new Error(
      'Powerhub snapshot manifest is incomplete'
    );
  }

  const manifestKeys =
    new Set(
      (manifest.routes ?? [])
        .map(route => route.key)
    );

  const captures = new Map();

  for (const route of POWERHUB_ROUTES) {
    if (!manifestKeys.has(route.key)) {
      throw new Error(
        `Powerhub snapshot is missing ${route.label}`
      );
    }

    const routeDir =
      assertDirectChild(
        snapshotDir,
        path.join(
          snapshotDir,
          route.key
        )
      );

    const routeStat =
      await fs.lstat(routeDir);

    if (
      !routeStat.isDirectory() ||
      routeStat.isSymbolicLink()
    ) {
      throw new Error(
        `Invalid Powerhub snapshot directory for ${route.label}`
      );
    }

    const [html, text, metadata] =
      await Promise.all([
        fs.readFile(
          path.join(routeDir, 'page.html'),
          'utf8'
        ),
        fs.readFile(
          path.join(routeDir, 'page.txt'),
          'utf8'
        ),
        fs.readFile(
          path.join(routeDir, 'metadata.json'),
          'utf8'
        ).then(JSON.parse)
      ]);

    if (
      metadata.route !== route.key ||
      metadata.source_url !== route.url
    ) {
      throw new Error(
        `Powerhub metadata mismatch for ${route.label}`
      );
    }

    captures.set(
      route.key,
      {
        html,
        text,
        routeDir
      }
    );
  }

  return {
    capturedAt: manifest.captured_at,
    captures
  };
}

export async function buildReplay({
  cacheDir = DEFAULT_CACHE_DIR
} = {}) {
  const resolvedCache =
    path.resolve(cacheDir);
  const source =
    await loadSnapshot(resolvedCache);
  const replayRoot =
    path.resolve(
      resolvedCache,
      'replay'
    );
  const latestDir =
    assertDirectChild(
      replayRoot,
      path.join(replayRoot, 'latest')
    );
  const tempDir =
    assertDirectChild(
      replayRoot,
      path.join(
        replayRoot,
        `latest.tmp-${process.pid}-${Date.now()}`
      )
    );

  await fs.mkdir(
    path.join(tempDir, 'assets'),
    { recursive: true }
  );

  try {
    await Promise.all([
      fs.writeFile(
        path.join(tempDir, 'index.html'),
        renderIndex(source.capturedAt),
        'utf8'
      ),
      fs.writeFile(
        path.join(tempDir, 'styles.css'),
        renderCss(),
        'utf8'
      )
    ]);

    for (const route of POWERHUB_ROUTES) {
      const capture =
        source.captures.get(route.key);

      await Promise.all([
        fs.writeFile(
          path.join(
            tempDir,
            `${route.key}.html`
          ),
          renderRoutePage(
            route,
            capture,
            source.capturedAt
          ),
          'utf8'
        ),
        fs.copyFile(
          path.join(
            capture.routeDir,
            'screenshot.png'
          ),
          path.join(
            tempDir,
            'assets',
            `${route.key}.png`
          )
        )
      ]);
    }

    const replayManifest = {
      site: 'Tesla Powerhub',
      captured_at: source.capturedAt,
      routes: POWERHUB_ROUTES.map(route => ({
        key: route.key,
        label: route.label,
        file: `${route.key}.html`
      })),
      credentials_captured: false,
      network_required_for_replay: false
    };

    await fs.writeFile(
      path.join(
        tempDir,
        'replay-manifest.json'
      ),
      `${JSON.stringify(replayManifest, null, 2)}\n`,
      'utf8'
    );

    await validateReplay(tempDir);

    await fs.mkdir(
      replayRoot,
      { recursive: true }
    );
    await fs.rm(
      latestDir,
      {
        recursive: true,
        force: true
      }
    );
    await fs.rename(
      tempDir,
      latestDir
    );

    console.log('POWERHUB REPLAY BUILT');
    console.log(`Directory: ${latestDir}`);

    return latestDir;
  } catch (error) {
    await fs.rm(
      tempDir,
      {
        recursive: true,
        force: true
      }
    );
    throw error;
  }
}

if (
  process.argv[1] &&
  pathToFileURL(
    path.resolve(process.argv[1])
  ).href === import.meta.url
) {
  await buildReplay();
}
