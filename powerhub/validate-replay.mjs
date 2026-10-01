import fs from 'node:fs/promises';
import path from 'node:path';
import {
  pathToFileURL
} from 'node:url';

const DEFAULT_CACHE_DIR =
  process.env.POWERHUB_CACHE_DIR ??
  'C:\\agent-web-cache\\tesla-powerhub';

const FORBIDDEN_TEXT = Object.freeze([
  'https://powerhub.energy.tesla.com',
  'tesla.com',
  'mapbox.com',
  'forms.office.com',
  'ws://',
  'wss://',
  'authorization',
  'bearer',
  'access_token',
  'refresh_token'
]);

const REQUIRED_CSP = Object.freeze([
  "default-src 'self'",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "img-src 'self' data:"
]);

async function listFiles(root) {
  const files = [];

  async function visit(directory) {
    const entries =
      await fs.readdir(
        directory,
        { withFileTypes: true }
      );

    for (const entry of entries) {
      const fullPath =
        path.join(
          directory,
          entry.name
        );

      if (entry.isSymbolicLink()) {
        throw new Error(
          `Replay contains a symbolic link: ${path.relative(root, fullPath)}`
        );
      }

      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  await visit(root);
  return files;
}

function inspectHtml(
  relativePath,
  contents,
  failures
) {
  const prohibitedPatterns = [
    [/\bfetch\s*\(/i, 'fetch('],
    [/\bXMLHttpRequest\b/i, 'XMLHttpRequest'],
    [/\bWebSocket\s*\(/i, 'WebSocket('],
    [/\bEventSource\s*\(/i, 'EventSource('],
    [/<form\b/i, '<form'],
    [/<script\b/i, 'script element'],
    [/<link\b[^>]*\brel\s*=\s*["']?stylesheet["']?[^>]*\bhref\s*=\s*["']?(?:https?:|\/\/)/i, 'external stylesheet'],
    [/<link\b[^>]*\bhref\s*=\s*["']?(?:https?:|\/\/)[^>]*\brel\s*=\s*["']?stylesheet/i, 'external stylesheet'],
    [/\b(?:href|src|action|formaction)\s*=\s*["']\s*(?:https?:|\/\/)/i, 'external URL attribute']
  ];

  for (const [pattern, label] of prohibitedPatterns) {
    if (pattern.test(contents)) {
      failures.push(
        `${relativePath}: contains ${label}`
      );
    }
  }

  for (const directive of REQUIRED_CSP) {
    if (!contents.includes(directive)) {
      failures.push(
        `${relativePath}: missing CSP directive ${directive}`
      );
    }
  }
}

export async function validateReplay(
  replayDir = path.join(
    DEFAULT_CACHE_DIR,
    'replay',
    'latest'
  )
) {
  const root =
    path.resolve(replayDir);
  const stat =
    await fs.stat(root);

  if (!stat.isDirectory()) {
    throw new Error(
      `Replay path is not a directory: ${root}`
    );
  }

  const files =
    await listFiles(root);
  const failures = [];

  if (files.length === 0) {
    failures.push(
      'Replay contains no files'
    );
  }

  for (const file of files) {
    const relativePath =
      path.relative(root, file);
    const buffer =
      await fs.readFile(file);
    const lower =
      buffer.toString('latin1').toLowerCase();

    for (const forbidden of FORBIDDEN_TEXT) {
      if (lower.includes(forbidden.toLowerCase())) {
        failures.push(
          `${relativePath}: contains forbidden text ${forbidden}`
        );
      }
    }

    if (
      path.extname(file).toLowerCase() ===
      '.html'
    ) {
      inspectHtml(
        relativePath,
        buffer.toString('utf8'),
        failures
      );
    }

    if (
      path.extname(file).toLowerCase() ===
      '.css' &&
      /(?:@import\s+|url\s*\(\s*["']?)(?:https?:|\/\/)/i.test(
        buffer.toString('utf8')
      )
    ) {
      failures.push(
        `${relativePath}: contains an external stylesheet resource`
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(
      'Powerhub replay validation failed:\n' +
      failures
        .map(failure => `- ${failure}`)
        .join('\n')
    );
  }

  return {
    directory: root,
    files: files.length
  };
}

if (
  process.argv[1] &&
  pathToFileURL(
    path.resolve(process.argv[1])
  ).href === import.meta.url
) {
  const result =
    await validateReplay();

  console.log('POWERHUB REPLAY VALID');
  console.log(`Directory: ${result.directory}`);
  console.log(`Files: ${result.files}`);
}
