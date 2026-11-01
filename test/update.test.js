import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  compareVersions,
  downloadAsset,
  fetchLatestRelease,
  installFromDirectory,
  installFromTarball,
  pickAsset,
  prepareTarball,
  satisfiesRange,
} from '../lib/update.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-retry-update-'));

function makeCase() {
  return fs.mkdtempSync(path.join(root, 'case-'));
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function releaseFixture(overrides = {}) {
  return {
    tag_name: 'v0.6.0',
    published_at: '2026-10-01T00:00:00Z',
    html_url: 'https://github.com/kouzerror/dsh-retry/releases/tag/v0.6.0',
    body: 'release notes',
    assets: [
      {
        name: 'dsh-retry-0.6.0.tgz',
        size: 1234,
        digest: `sha256:${'a'.repeat(64)}`,
        browser_download_url: 'https://example.invalid/dsh-retry-0.6.0.tgz',
      },
    ],
    ...overrides,
  };
}

function jsonResponse(body, { ok = true, status = 200, statusText = 'OK' } = {}) {
  return { ok, status, statusText, json: async () => body };
}

function writePackage(dir, { version = '9.9.9', client = 'export const marker = "new";\n' } = {}) {
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-retry', version }));
  fs.writeFileSync(path.join(dir, 'lib', 'index.js'), 'export const name = "dsh-retry";\n');
  fs.writeFileSync(path.join(dir, 'lib', 'client.js'), client);
  fs.writeFileSync(path.join(dir, 'scripts', 'restart-helper.ps1'), 'Write-Host helper\n');
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), 'insert: []\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# dsh-retry\n');
  fs.writeFileSync(path.join(dir, 'LICENSE'), 'MIT\n');
}

function findTempFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findTempFiles(full));
    else if (entry.name.endsWith('.dsh-retry-new')) found.push(full);
  }
  return found;
}

test('compareVersions orders numeric segments, prereleases and build metadata', () => {
  assert.equal(compareVersions('0.5.1', '0.5.1'), 0);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('0.9.9', '0.10.0'), -1);
  assert.equal(compareVersions('0.5', '0.5.0'), 0);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0-rc.2'), -1);
  assert.equal(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10'), -1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  // Build metadata never affects ordering.
  assert.equal(compareVersions('1.0.0', '1.0.0+build.7'), 0);
  // Released tags travel with a leading v.
  assert.equal(compareVersions('v0.6.0', '0.5.1'), 1);
});

test('pickAsset selects the tarball asset and skips the rest', () => {
  assert.deepEqual(pickAsset(releaseFixture()), {
    name: 'dsh-retry-0.6.0.tgz',
    size: 1234,
    digest: `sha256:${'a'.repeat(64)}`,
    url: 'https://example.invalid/dsh-retry-0.6.0.tgz',
  });

  // A release without a .tgz publishes nothing installable.
  assert.equal(pickAsset(releaseFixture({ assets: [{ name: 'source.zip', browser_download_url: 'https://example.invalid/src.zip' }] })), null);
  assert.equal(pickAsset(releaseFixture({ assets: [] })), null);
  assert.equal(pickAsset({}), null);
  // An asset without a download URL is not usable either.
  assert.equal(pickAsset(releaseFixture({ assets: [{ name: 'dsh-retry-0.6.0.tgz' }] })), null);
  // Missing size/digest stay null instead of rejecting the asset.
  const bare = pickAsset(releaseFixture({ assets: [{ name: 'dsh-retry-0.6.0.tgz', browser_download_url: 'https://example.invalid/x.tgz' }] }));
  assert.deepEqual(bare, { name: 'dsh-retry-0.6.0.tgz', size: null, digest: null, url: 'https://example.invalid/x.tgz' });
});

test('fetchLatestRelease sends the GitHub headers, parses the release and caches it', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(releaseFixture());
  };

  const release = await fetchLatestRelease({ fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/repos/kouzerror/dsh-retry/releases/latest');
  assert.equal(calls[0].options.headers['user-agent'], 'dsh-retry-self-update');
  assert.equal(calls[0].options.headers.accept, 'application/vnd.github+json');
  assert.deepEqual(release, {
    version: '0.6.0',
    tag: 'v0.6.0',
    publishedAt: '2026-10-01T00:00:00Z',
    htmlUrl: 'https://github.com/kouzerror/dsh-retry/releases/tag/v0.6.0',
    notes: 'release notes',
    asset: {
      name: 'dsh-retry-0.6.0.tgz',
      size: 1234,
      digest: `sha256:${'a'.repeat(64)}`,
      url: 'https://example.invalid/dsh-retry-0.6.0.tgz',
    },
  });

  // Second lookup comes from the in-memory cache: no network.
  const cached = await fetchLatestRelease({ fetchImpl });
  assert.deepEqual(cached, release);
  assert.equal(calls.length, 1);
});

test('fetchLatestRelease fails on non-2xx and does not cache the failure', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({}, { ok: false, status: 403, statusText: 'Forbidden' });
    return jsonResponse(releaseFixture());
  };

  await assert.rejects(fetchLatestRelease({ fetchImpl }), /github release request failed: 403 Forbidden/);
  const release = await fetchLatestRelease({ fetchImpl });
  assert.equal(release.version, '0.6.0');
  assert.equal(calls, 2);
});

test('fetchLatestRelease rejects a release without a tag', async () => {
  const fetchImpl = async () => jsonResponse(releaseFixture({ tag_name: '' }));
  await assert.rejects(fetchLatestRelease({ fetchImpl }), /no tag_name/);
});

test('downloadAsset streams the bytes, verifies size and returns their sha256', async () => {
  const dir = makeCase();
  const destPath = path.join(dir, 'asset.tgz');
  const payload = Buffer.from('pretend this is a tarball');
  const digest = `sha256:${sha256(payload)}`;
  const fetchImpl = async () => new Response(payload);

  const result = await downloadAsset({
    url: 'https://example.invalid/dsh-retry-0.6.0.tgz',
    destPath,
    size: payload.length,
    digest,
    fetchImpl,
  });
  assert.equal(result.bytes, payload.length);
  assert.equal(result.sha256, sha256(payload));
  assert.deepEqual(fs.readFileSync(destPath), payload);
});

test('downloadAsset deletes the file when the digest does not match', async () => {
  const dir = makeCase();
  const destPath = path.join(dir, 'asset.tgz');
  const payload = Buffer.from('tampered');
  const fetchImpl = async () => new Response(payload);

  await assert.rejects(
    downloadAsset({
      url: 'https://example.invalid/x.tgz',
      destPath,
      size: payload.length,
      digest: `sha256:${'0'.repeat(64)}`,
      fetchImpl,
    }),
    /sha256 mismatch/,
  );
  assert.equal(fs.existsSync(destPath), false);
});

test('downloadAsset deletes the file when the byte count does not match', async () => {
  const dir = makeCase();
  const destPath = path.join(dir, 'asset.tgz');
  const payload = Buffer.from('short');
  const fetchImpl = async () => new Response(payload);

  await assert.rejects(
    downloadAsset({
      url: 'https://example.invalid/x.tgz',
      destPath,
      size: payload.length + 10,
      digest: null,
      fetchImpl,
    }),
    /downloaded 5 bytes, expected 15/,
  );
  assert.equal(fs.existsSync(destPath), false);
});

test('downloadAsset skips verification when no digest is published', async () => {
  const dir = makeCase();
  const destPath = path.join(dir, 'asset.tgz');
  const payload = Buffer.from('no digest');
  const fetchImpl = async () => new Response(payload);

  const result = await downloadAsset({ url: 'https://example.invalid/x.tgz', destPath, size: payload.length, digest: null, fetchImpl });
  assert.equal(result.bytes, payload.length);
  assert.equal(fs.readFileSync(destPath, 'utf8'), 'no digest');
});

test('installFromDirectory replaces the published entries in place', () => {
  const dir = makeCase();
  const sourceDir = path.join(dir, 'package');
  const target = path.join(dir, 'installed');
  writePackage(sourceDir, { version: '0.6.0', client: 'export const marker = "client-0.6.0";\n' });

  fs.mkdirSync(path.join(target, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(target, 'lib', 'client.js'), 'export const marker = "old";\n');
  fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: 'dsh-retry', version: '0.5.1' }));
  fs.writeFileSync(path.join(target, 'stale.txt'), 'left behind');

  const lines = [];
  const result = installFromDirectory({ sourceDir, root: target, log: (line) => lines.push(String(line)) });
  assert.deepEqual(result, { version: '0.6.0' });

  assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).version, '0.6.0');
  assert.equal(fs.readFileSync(path.join(target, 'lib', 'client.js'), 'utf8'), 'export const marker = "client-0.6.0";\n');
  // Bytes are copied exactly, not through a text transform.
  assert.deepEqual(fs.readFileSync(path.join(target, 'lib', 'client.js')), fs.readFileSync(path.join(sourceDir, 'lib', 'client.js')));
  assert.equal(fs.existsSync(path.join(target, 'scripts', 'restart-helper.ps1')), true);
  // Files a newer version no longer publishes are not removed.
  assert.equal(fs.readFileSync(path.join(target, 'stale.txt'), 'utf8'), 'left behind');
  // No half-written temporary files survive.
  assert.deepEqual(findTempFiles(target), []);
  assert.match(lines.join('\n'), /installed dsh-retry 0\.6\.0/);
});

test('installFromDirectory refuses anything that is not the dsh-retry package', () => {
  const dir = makeCase();
  const sourceDir = path.join(dir, 'package');
  writePackage(sourceDir);
  fs.writeFileSync(path.join(sourceDir, 'package.json'), JSON.stringify({ name: 'some-other-plugin', version: '1.0.0' }));
  assert.throws(
    () => installFromDirectory({ sourceDir, root: path.join(dir, 'target') }),
    /refusing to install some-other-plugin: expected dsh-retry/,
  );

  fs.rmSync(path.join(sourceDir, 'package.json'));
  assert.throws(() => installFromDirectory({ sourceDir, root: path.join(dir, 'target') }), /cannot read .*package\.json/);
});

test('installFromDirectory fails loudly when the package is incomplete', () => {
  const dir = makeCase();
  const sourceDir = path.join(dir, 'package');
  writePackage(sourceDir);
  fs.rmSync(path.join(sourceDir, 'README.md'));
  const lines = [];
  const target = path.join(dir, 'target');

  assert.throws(
    () => installFromDirectory({ sourceDir, root: target, log: (line) => lines.push(String(line)) }),
    /package is missing README\.md/,
  );
  // The failure is reported, not rolled back.
  assert.equal(fs.existsSync(path.join(target, 'lib', 'index.js')), true);
  assert.match(lines.join('\n'), /already replaced files are not rolled back/);
});

test('installFromTarball extracts a real tarball and installs it', () => {
  const dir = makeCase();
  const packRoot = path.join(dir, 'pack');
  const sourceDir = path.join(packRoot, 'package');
  writePackage(sourceDir, { version: '0.6.0' });
  const tarball = path.join(dir, 'dsh-retry-0.6.0.tgz');
  const tar = spawnSync('tar', ['-czf', tarball, '-C', packRoot, 'package'], { encoding: 'utf8' });
  assert.equal(tar.status, 0, String(tar.stderr));

  const target = path.join(dir, 'installed');
  fs.mkdirSync(target, { recursive: true });
  const result = installFromTarball({ tarball, root: target, log: () => {} });
  assert.deepEqual(result, { version: '0.6.0' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).version, '0.6.0');
  assert.equal(fs.readFileSync(path.join(target, 'lib', 'client.js'), 'utf8'), fs.readFileSync(path.join(sourceDir, 'lib', 'client.js'), 'utf8'));
});

test('satisfiesRange understands the ranges this package publishes', () => {
  const dshRange = '>=0.2.0-rc.1 <0.3.0-0';
  assert.equal(satisfiesRange('0.2.0', dshRange), true);
  assert.equal(satisfiesRange('0.2.0-rc.1', dshRange), true);
  assert.equal(satisfiesRange('0.2.9', dshRange), true);
  assert.equal(satisfiesRange('0.1.9', dshRange), false);
  assert.equal(satisfiesRange('0.3.0', dshRange), false);
  assert.equal(satisfiesRange('0.3.0-0', dshRange), false);

  // Single bounds, node style, and whitespace tolerance.
  assert.equal(satisfiesRange('24.21.0', '>=22.19.0'), true);
  assert.equal(satisfiesRange('20.0.0', '>=22.19.0'), false);
  assert.equal(satisfiesRange('1.2.3', '  <2.0.0  '), true);
  assert.equal(satisfiesRange('2.0.0', '<2.0.0'), false);
});

test('satisfiesRange returns null for a range it cannot parse', () => {
  assert.equal(satisfiesRange('0.2.0', '^0.2.0'), null);
  assert.equal(satisfiesRange('0.2.0', '0.2.0'), null);
  assert.equal(satisfiesRange('0.2.0', '>=0.2'), null);
  assert.equal(satisfiesRange('0.2.0', '>0.2.0'), null);
  assert.equal(satisfiesRange('0.2.0', '>= 0.2.0'), null);
  assert.equal(satisfiesRange('0.2.0', ''), null);
  assert.equal(satisfiesRange('0.2.0', null), null);
});

test('prepareTarball exposes the manifest before anything is installed', () => {
  const dir = makeCase();
  const packRoot = path.join(dir, 'pack');
  const sourceDir = path.join(packRoot, 'package');
  writePackage(sourceDir, { version: '0.6.0' });
  fs.writeFileSync(
    path.join(sourceDir, 'package.json'),
    JSON.stringify({ name: 'dsh-retry', version: '0.6.0', engines: { dsh: '>=0.2.0-rc.1 <0.3.0-0' } }),
  );
  const tarball = path.join(dir, 'dsh-retry-0.6.0.tgz');
  const tar = spawnSync('tar', ['-czf', tarball, '-C', packRoot, 'package'], { encoding: 'utf8' });
  assert.equal(tar.status, 0, String(tar.stderr));

  const prepared = prepareTarball({ tarball });
  try {
    assert.equal(prepared.manifest.version, '0.6.0');
    assert.equal(prepared.manifest.engines.dsh, '>=0.2.0-rc.1 <0.3.0-0');
    assert.equal(fs.existsSync(path.join(prepared.sourceDir, 'package.json')), true);
  } finally {
    prepared.cleanup();
  }
  assert.equal(fs.existsSync(prepared.sourceDir), false);
});

test('fetchLatestRelease rejects an HTML error page instead of returning garbage', async () => {
  const fetchImpl = async () => new Response('<html><body>502 Bad Gateway</body></html>', { status: 502, statusText: 'Bad Gateway' });
  await assert.rejects(fetchLatestRelease({ fetchImpl }), /github release request failed: 502 Bad Gateway/);
});

test('fetchLatestRelease rejects a 200 response that is not JSON', async () => {
  const fetchImpl = async () => new Response('<html><body>not json</body></html>', { status: 200 });
  await assert.rejects(fetchLatestRelease({ fetchImpl }), (error) => error instanceof SyntaxError);
});