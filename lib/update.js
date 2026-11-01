import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const RELEASE_URL = 'https://api.github.com/repos/kouzerror/dsh-retry/releases/latest';
const RELEASE_CACHE_MS = 10 * 60_000;
const USER_AGENT = 'dsh-retry-self-update';
/** Root directory npm puts every published file under inside the tarball. */
const PACKAGE_DIR = 'package';
/** Everything the published package needs at runtime; docs are included as-is. */
const ENTRIES = ['lib', 'scripts', 'cordis.patch.yml', 'README.md', 'LICENSE', 'package.json'];
const TEMP_SUFFIX = '.dsh-retry-new';

/**
 * Successful responses, keyed by the fetcher that produced them. Keying by
 * fetcher lets the process cache the real GitHub lookup while injected fetchers
 * in tests never read somebody else's cached release.
 */
const releaseCache = new WeakMap();

/**
 * Node's fetch defaults to the Happy Eyeballs "autoselect" DNS order; on this
 * machine that path stalls for api.github.com while IPv4-first answers in
 * milliseconds, so every request opts into IPv4 first.
 */
const NETWORK_OPTIONS = Object.freeze({ autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 250 });

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`request timed out after ${ms}ms`));
  }, ms);
  timer.unref?.();
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

function removeQuietly(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // Cleanup must not hide the error that made it necessary.
  }
}

function parseVersion(value) {
  const text = String(value ?? '').trim().replace(/^v/i, '');
  // Build metadata is ignored for ordering, per semver.
  const withoutBuild = text.split('+')[0];
  const dash = withoutBuild.indexOf('-');
  const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  const pre = dash === -1 ? '' : withoutBuild.slice(dash + 1);
  return {
    numbers: core.split('.').map((part) => {
      const parsed = Number.parseInt(part, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    }),
    pre: pre === '' ? null : pre.split('.'),
  };
}

function compareNumbers(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

/** semver prerelease ordering: numeric identifiers sort numerically and below text. */
function comparePrerelease(left, right) {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (index >= left.length) return -1;
    if (index >= right.length) return 1;
    const a = left[index];
    const b = right[index];
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      const x = Number(a);
      const y = Number(b);
      if (x !== y) return x < y ? -1 : 1;
      continue;
    }
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

/** Semver comparison of two version strings: -1, 0 or 1. */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  const core = compareNumbers(left.numbers, right.numbers);
  if (core !== 0) return core;
  return comparePrerelease(left.pre, right.pre);
}

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Does `version` satisfy a simple `>=x <y` range?
 *
 * Only the operators this package publishes are understood. Anything else
 * returns null instead of guessing, so a caller can allow the update and say
 * that it could not verify it rather than block on a range it misread.
 */
export function satisfiesRange(version, range) {
  if (typeof range !== 'string') return null;
  const tokens = range.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const constraints = [];
  for (const token of tokens) {
    const match = /^(>=|<)(.+)$/.exec(token);
    if (match === null || !VERSION_PATTERN.test(match[2])) return null;
    constraints.push({ op: match[1], bound: match[2] });
  }
  return constraints.every(({ op, bound }) => {
    const comparison = compareVersions(version, bound);
    return op === '>=' ? comparison >= 0 : comparison < 0;
  });
}

/** The `.tgz` asset of a release, or null when the release publishes none. */
export function pickAsset(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const asset = assets.find(
    (candidate) =>
      typeof candidate?.name === 'string' &&
      candidate.name.endsWith('.tgz') &&
      typeof candidate.browser_download_url === 'string' &&
      candidate.browser_download_url !== '',
  );
  if (!asset) return null;
  return {
    name: asset.name,
    size: Number.isInteger(asset.size) ? asset.size : null,
    digest: typeof asset.digest === 'string' && asset.digest !== '' ? asset.digest : null,
    url: asset.browser_download_url,
  };
}

/**
 * Latest published release, cached for ten minutes. A failed lookup is never
 * cached: the next click should be able to retry.
 */
export async function fetchLatestRelease({ fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const cached = releaseCache.get(fetchImpl);
  if (cached !== undefined && Date.now() - cached.at < RELEASE_CACHE_MS) return cached.value;

  const { signal, cancel } = timeoutSignal(timeoutMs);
  try {
    const response = await fetchImpl(RELEASE_URL, {
      ...NETWORK_OPTIONS,
      headers: { 'user-agent': USER_AGENT, accept: 'application/vnd.github+json' },
      redirect: 'follow',
      signal,
    });
    if (!response.ok) {
      throw new Error(`github release request failed: ${response.status} ${response.statusText ?? ''}`.trim());
    }
    const json = await response.json();
    const tag = typeof json.tag_name === 'string' ? json.tag_name : '';
    const version = tag.replace(/^v/i, '').trim();
    if (version === '') throw new Error('github release has no tag_name');
    const value = {
      version,
      tag,
      publishedAt: json.published_at ?? null,
      htmlUrl: json.html_url ?? null,
      notes: json.body ?? null,
      asset: pickAsset(json),
    };
    releaseCache.set(fetchImpl, { at: Date.now(), value });
    return value;
  } finally {
    cancel();
  }
}

function toReadable(body) {
  if (body === null || body === undefined) return null;
  // node:stream/web bodies (global fetch) are async iterable, but converting is
  // what makes pipeline() tear the request down on an error.
  if (typeof body.getReader === 'function') return Readable.fromWeb(body);
  return body;
}

function expectedSha256(digest) {
  if (typeof digest !== 'string') return null;
  const match = /^sha256:([0-9a-f]{64})$/i.exec(digest.trim());
  return match === null ? null : match[1].toLowerCase();
}

/**
 * Stream an asset to disk, hashing it on the way. A file that fails either check
 * is deleted so the caller can never install a partial or wrong download.
 */
export async function downloadAsset({
  url,
  destPath,
  size = null,
  digest = null,
  fetchImpl = fetch,
  timeoutMs = 180_000,
}) {
  const { signal, cancel } = timeoutSignal(timeoutMs);
  let bytes = 0;
  const hash = createHash('sha256');
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    const response = await fetchImpl(url, {
      ...NETWORK_OPTIONS,
      headers: { 'user-agent': USER_AGENT },
      redirect: 'follow',
      signal,
    });
    if (!response.ok) {
      throw new Error(`asset download failed: ${response.status} ${response.statusText ?? ''}`.trim());
    }
    const source = toReadable(response.body);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    if (source === null) {
      fs.writeFileSync(destPath, '');
    } else {
      await pipeline(source, meter, fs.createWriteStream(destPath));
    }
  } catch (error) {
    removeQuietly(destPath);
    throw error;
  } finally {
    cancel();
  }

  const sha256 = hash.digest('hex');
  if (size !== null && size !== undefined && bytes !== size) {
    removeQuietly(destPath);
    throw new Error(`downloaded ${bytes} bytes, expected ${size}`);
  }
  const expected = expectedSha256(digest);
  if (expected !== null && expected !== sha256) {
    removeQuietly(destPath);
    throw new Error(`sha256 mismatch: expected ${expected}, got ${sha256}`);
  }
  return { bytes, sha256 };
}

/** Unpack a tarball with the system tar (bsdtar on Windows 10+). */
export function extractTarball({ tarball, destDir, tarPath = 'tar' }) {
  fs.mkdirSync(destDir, { recursive: true });
  const result = spawnSync(tarPath, ['-xzf', tarball, '-C', destDir], { encoding: 'utf8' });
  if (result.error) throw new Error(`tar failed: ${result.error.message}`);
  if (result.status !== 0) {
    const stderr = String(result.stderr ?? '').trim();
    throw new Error(`tar exited with ${result.status}${stderr === '' ? '' : `: ${stderr}`}`);
  }
}

function copyFileAtomic(source, dest) {
  const tmp = `${dest}${TEMP_SUFFIX}`;
  fs.copyFileSync(source, tmp);
  fs.renameSync(tmp, dest);
}

function copyDirectory(source, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else if (entry.isFile()) copyFileAtomic(from, to);
  }
}

/**
 * Replace the plugin files under `root` with the package unpacked at `sourceDir`.
 *
 * Only the published entries are touched, so files a newer version dropped stay
 * behind; nothing is rolled back when a later entry fails, because the point is
 * to report the failure rather than hide it. The app must restart afterwards:
 * the running process still holds the old modules.
 */
export function installFromDirectory({ sourceDir, root, log = () => {} }) {
  const manifestPath = path.join(sourceDir, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${manifestPath}: ${String(error?.message ?? error)}`);
  }
  if (manifest?.name !== 'dsh-retry') {
    throw new Error(`refusing to install ${String(manifest?.name ?? 'a package')}: expected dsh-retry`);
  }
  const version = String(manifest.version ?? '');

  fs.mkdirSync(root, { recursive: true });
  const replaced = [];
  try {
    for (const entry of ENTRIES) {
      const from = path.join(sourceDir, entry);
      const to = path.join(root, entry);
      let stat;
      try {
        stat = fs.statSync(from);
      } catch {
        throw new Error(`package is missing ${entry}`);
      }
      log(`installing ${entry}`);
      if (stat.isDirectory()) copyDirectory(from, to);
      else copyFileAtomic(from, to);
      replaced.push(entry);
    }
  } catch (error) {
    log(
      `install failed after replacing ${replaced.length === 0 ? 'nothing' : replaced.join(', ')}; ` +
        `already replaced files are not rolled back: ${String(error?.message ?? error)}`,
    );
    throw error;
  }
  log(`installed dsh-retry ${version} into ${root} (${replaced.length} entries)`);
  return { version };
}

/**
 * Unpack a downloaded tarball into a fresh temp directory and read its manifest.
 *
 * The caller gets the manifest before anything is installed, so it can refuse an
 * incompatible release. `cleanup` must be called when the caller is done.
 */
export function prepareTarball({ tarball, log = () => {} }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-retry-update-'));
  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
  try {
    log(`extracting ${tarball}`);
    extractTarball({ tarball, destDir: tmp });
    const sourceDir = path.join(tmp, PACKAGE_DIR);
    const manifestPath = path.join(sourceDir, 'package.json');
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      throw new Error(`cannot read ${manifestPath}: ${String(error?.message ?? error)}`);
    }
    return { sourceDir, manifest, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** Extract the downloaded tarball next to the temp dir, install, then clean up. */
export function installFromTarball({ tarball, root, log = () => {} }) {
  const prepared = prepareTarball({ tarball, log });
  try {
    return installFromDirectory({ sourceDir: prepared.sourceDir, root, log });
  } finally {
    prepared.cleanup();
  }
}