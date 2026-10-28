import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { desktopPaths } from './desktop.js';
import { createLogger, readTail } from './log.js';
import { helperScript, launchHelper } from './helper.js';
import { buildPatchedAsar, inspectPatchState } from './patch.js';

export const name = 'dsh-retry';
export const inject = ['webServer'];

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HELPER_SCRIPT = helperScript(PACKAGE_ROOT);
const require = createRequire(import.meta.url);
const PACKAGE_VERSION = readPackageVersion();

function readPackageVersion() {
  try {
    return require('../package.json').version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function isPatched(state) {
  return Boolean(state && state.mainPatched && state.accountPatched);
}

/** Live archive already carries exactly the bytes our staged archive would. */
function isCurrent(state, stagedState) {
  return (
    isPatched(state) &&
    stagedState !== null &&
    state.mainSha256 === stagedState.mainSha256 &&
    state.accountSha256 === stagedState.accountSha256
  );
}

function reply(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

function statOrNull(file) {
  try {
    const stat = fs.statSync(file);
    return { bytes: stat.size, mtime: stat.mtime.toISOString(), mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

function readJsonOrNull(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Can the helper replace the archive next to the running app? */
export function canWriteResources(paths) {
  try {
    fs.accessSync(path.dirname(paths.asar), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** A marker whose helper process is still alive means the patch is already armed. */
function armedHelperPid(paths) {
  const marker = readJsonOrNull(paths.marker);
  if (marker === null || typeof marker.helperPid !== 'number') return null;
  try {
    process.kill(marker.helperPid, 0);
    return marker.helperPid;
  } catch {
    return null;
  }
}

/** Public status payload; kept pure so tests can exercise it without a server. */
export function statusPayload(paths) {
  const state = inspectPatchState(paths.asar);
  const staged = statOrNull(paths.stagedAsar);
  const stagedMeta = readJsonOrNull(paths.stagedMeta);
  return {
    ok: true,
    desktop: true,
    plugin: { name, version: PACKAGE_VERSION },
    asar: paths.asar,
    desktopVersion: state.desktopVersion ?? null,
    patched: isPatched(state),
    mainPatched: Boolean(state.mainPatched),
    accountPatched: Boolean(state.accountPatched),
    missing: { main: state.mainMissing ?? [], account: state.accountMissing ?? [] },
    mainPid: process.ppid,
    writeAccess: canWriteResources(paths),
    staged:
      staged === null
        ? null
        : {
            path: paths.stagedAsar,
            bytes: staged.bytes,
            mtime: staged.mtime,
            meta: stagedMeta === null ? null : { desktopVersion: stagedMeta.desktopVersion ?? null, builtAt: stagedMeta.builtAt ?? null, size: stagedMeta.size ?? null, mtimeMs: stagedMeta.mtimeMs ?? null },
          },
    backup: { path: paths.backup, exists: statOrNull(paths.backup) !== null },
    installedArmed: armedHelperPid(paths) !== null,
    helper: { log: readTail(paths.helperLog, 5) },
  };
}

/**
 * Build (or reuse) the patched archive for the installed app.asar. The archive
 * is patched from the pristine backup when one exists, so a stale patch left by
 * an older plugin version can be replaced by a fresh one. Returns:
 *   null                      – nothing to stage (no source available)
 *   {staged, built, expected, state, stagedState}
 * `expected` is the signature of the live archive the helper re-checks right
 * before swapping, so a DSH update during the wait aborts the install.
 */
export function ensureStaged(paths, log) {
  const source = fs.existsSync(paths.backup) ? paths.backup : paths.asar;
  if (!fs.existsSync(source)) return null;
  fs.mkdirSync(paths.staging, { recursive: true });
  const sourceStat = fs.statSync(source);
  const liveStat = fs.statSync(paths.asar);
  const sourceState = inspectPatchState(source);
  const meta = {
    plugin: PACKAGE_VERSION,
    source,
    sourceSize: sourceStat.size,
    sourceMtimeMs: sourceStat.mtimeMs,
    expectedSize: liveStat.size,
    expectedMtimeMs: liveStat.mtimeMs,
    desktopVersion: sourceState.desktopVersion ?? null,
    builtAt: new Date().toISOString(),
  };

  const reuseStaged = () => {
    if (!fs.existsSync(paths.stagedAsar) || !fs.existsSync(paths.stagedMeta)) return null;
    try {
      const previous = JSON.parse(fs.readFileSync(paths.stagedMeta, 'utf8'));
      const stagedState = inspectPatchState(paths.stagedAsar);
      const reusable =
        previous.plugin === meta.plugin &&
        previous.source === meta.source &&
        previous.sourceSize === meta.sourceSize &&
        previous.sourceMtimeMs === meta.sourceMtimeMs &&
        isPatched(stagedState);
      return reusable ? { stagedState, builtAt: previous.builtAt ?? null } : null;
    } catch {
      return null;
    }
  };

  let built = false;
  let reused = reuseStaged();
  if (reused === null) {
    log(`building patched app.asar from ${source}`);
    const result = buildPatchedAsar(source, paths.stagedAsar, { log });
    if (result.patchedAsar === null) {
      log('source asar is already patched; nothing to stage');
      return null;
    }
    fs.writeFileSync(paths.stagedMeta, `${JSON.stringify(meta, null, 2)}\n`);
    reused = { stagedState: inspectPatchState(paths.stagedAsar) };
    built = true;
    log(`staged patched asar: ${paths.stagedAsar}`);
  } else {
    log('reusing staged patched asar');
  }

  return {
    staged: paths.stagedAsar,
    built,
    expected: { size: meta.expectedSize, mtimeMs: meta.expectedMtimeMs },
    state: inspectPatchState(paths.asar),
    stagedState: reused.stagedState,
  };
}

/**
 * Arm one install-on-exit helper per app run when the live archive is not
 * current (missing patch, half patch, or a stale patch from an older plugin).
 * The helper installs silently when the app closes normally and never touches
 * the archive while DSH is running.
 */
export function armInstallOnExit(paths, log) {
  if (armedHelperPid(paths) !== null) {
    log('install-on-exit helper already armed');
    return false;
  }
  fs.mkdirSync(paths.staging, { recursive: true });
  const staged = ensureStaged(paths, log);
  if (staged === null) return false;
  if (isCurrent(staged.state, staged.stagedState)) {
    log('live app.asar is already current; nothing to arm');
    return false;
  }
  launchHelper({ script: HELPER_SCRIPT, paths, staged: staged.staged, log, installOnly: true, expected: staged.expected });
  return true;
}

/** Reject cross-site browser requests: the restart route must stay local. */
function sameOrigin(req) {
  const site = req.headers?.['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false;
  return true;
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const restarting = { value: false };

  ctx.effect(() => {
    const paths = desktopPaths();
    if (paths === null) return;
    const log = createLogger(paths.buildLog);
    const timer = setTimeout(() => {
      try {
        armInstallOnExit(paths, log);
      } catch (error) {
        log(`arming install-on-exit failed: ${String(error?.message ?? error)}`);
      }
    }, 3000);
    return () => clearTimeout(timer);
  });

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-retry/status',
      handler: safeRoute((req, res, paths) => reply(res, 200, statusPayload(paths))),
    }),
  );

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-retry/prepare',
      handler: safeRoute(async (req, res, paths) => {
        if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
        if (!sameOrigin(req)) return reply(res, 403, { ok: false, error: 'cross_origin_request' });
        if (!canWriteResources(paths)) return reply(res, 500, { ok: false, error: 'resources_not_writable' });
        const log = createLogger(paths.buildLog);
        const state = inspectPatchState(paths.asar);
        const staged = ensureStaged(paths, log);
        if (staged === null) return reply(res, 200, { ok: true, patched: isPatched(state), staged: null });
        return reply(res, 200, {
          ok: true,
          patched: isPatched(state),
          current: isCurrent(state, staged.stagedState),
          staged: { path: staged.staged, bytes: fs.statSync(staged.staged).size, built: staged.built },
        });
      }),
    }),
  );

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-retry/restart',
      handler: safeRoute(async (req, res, paths) => {
        if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
        if (!sameOrigin(req)) return reply(res, 403, { ok: false, error: 'cross_origin_request' });
        if (restarting.value) return reply(res, 409, { ok: false, error: 'restart_in_progress' });
        restarting.value = true;
        const log = createLogger(paths.buildLog);
        try {
          if (!canWriteResources(paths)) {
            return reply(res, 500, { ok: false, error: 'resources_not_writable' });
          }
          const state = inspectPatchState(paths.asar);
          const staged = ensureStaged(paths, log);
          if (isPatched(state) && (staged === null || isCurrent(state, staged.stagedState))) {
            log('writing restart trigger');
            fs.writeFileSync(paths.trigger, `${new Date().toISOString()}\n`);
            return reply(res, 200, { ok: true, mode: 'restart' });
          }
          if (staged === null) return reply(res, 500, { ok: false, error: 'nothing_to_install' });
          launchHelper({ script: HELPER_SCRIPT, paths, staged: staged.staged, log, expected: staged.expected });
          return reply(res, 200, { ok: true, mode: 'patch-and-restart', staged: staged.staged });
        } catch (error) {
          log(`restart failed: ${String(error?.message ?? error)}`);
          return reply(res, 500, { ok: false, error: String(error?.message ?? error) });
        } finally {
          restarting.value = false;
        }
      }),
    }),
  );
}

function safeRoute(handler) {
  return async (req, res) => {
    const paths = desktopPaths();
    if (paths === null) return reply(res, 409, { ok: false, error: 'not_desktop' });
    try {
      return await handler(req, res, paths);
    } catch (error) {
      return reply(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  };
}
