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

// Electron patches node:fs to treat `*.asar` as a directory. Statistics for the
// live archive must come from original-fs, otherwise its size reads as 0 and the
// helper would reject its own staged patch as stale.
const realFs = (() => {
  try {
    return require('original-fs');
  } catch {
    return fs;
  }
})();

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

/** Every patch feature this plugin version knows about is present. */
function isComplete(state) {
  return (
    isPatched(state) &&
    (state.mainMissing?.length ?? 0) === 0 &&
    (state.accountMissing?.length ?? 0) === 0
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

const MAX_AUTO_RESTARTS = 2;

/**
 * Auto-restart budget for one archive signature. The signature changes as soon
 * as DSH is updated, so a fresh update gets a fresh budget while a patch that
 * keeps failing cannot put the app into a restart loop.
 */
export function autoRestartBudget(paths, signature) {
  const guard = readJsonOrNull(paths.restartGuard);
  const attempts =
    guard !== null && guard.signature === signature && Number.isInteger(guard.attempts) ? guard.attempts : 0;
  return { signature, attempts, exhausted: attempts >= MAX_AUTO_RESTARTS };
}

function recordAutoRestart(paths, budget) {
  fs.mkdirSync(paths.staging, { recursive: true });
  const next = { signature: budget.signature, attempts: budget.attempts + 1, at: new Date().toISOString() };
  fs.writeFileSync(paths.restartGuard, `${JSON.stringify(next, null, 2)}\n`);
  return next;
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
    autoRestart: { limit: MAX_AUTO_RESTARTS, guard: readJsonOrNull(paths.restartGuard) },
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
  const liveStat = realFs.statSync(paths.asar);
  const sourceState = inspectPatchState(source);
  const meta = {
    plugin: PACKAGE_VERSION,
    source,
    sourceSize: sourceStat.size,
    sourceMtimeMs: sourceStat.mtimeMs,
    expectedSize: liveStat.size,
    expectedMtimeMs: liveStat.mtimeMs,
    // Kept for the status payload; the helper re-checks the live archive itself.
    size: liveStat.size,
    mtimeMs: liveStat.mtimeMs,
    desktopVersion: sourceState.desktopVersion ?? null,
    builtAt: new Date().toISOString(),
  };

  const reuseStaged = () => {
    if (!fs.existsSync(paths.stagedAsar) || !fs.existsSync(paths.stagedMeta)) return null;
    try {
      const previous = JSON.parse(fs.readFileSync(paths.stagedMeta, 'utf8'));
      const stagedState = inspectPatchState(paths.stagedAsar);
      const reusable =
        previous.source === meta.source &&
        previous.sourceSize === meta.sourceSize &&
        previous.sourceMtimeMs === meta.sourceMtimeMs &&
        isComplete(stagedState);
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
 * Make the live archive carry the current patch. DSH keeps app.asar open without
 * FILE_SHARE_DELETE, so the archive can never be replaced while the app runs, and
 * a helper that waits for a later exit is torn down before it can act. The only
 * verified path is the short-lived restart helper: stop the app, swap the archive,
 * start it again. That happens once after a DSH update, guarded against loops.
 */
export function ensureInstalled(paths, log, { autoRestart = true } = {}) {
  fs.mkdirSync(paths.staging, { recursive: true });
  const liveState = inspectPatchState(paths.asar);
  const staged = ensureStaged(paths, log);
  if (staged === null) {
    log('nothing to stage: live archive is already patched');
    return { status: 'nothing_to_stage' };
  }
  if (isCurrent(liveState, staged.stagedState)) {
    log('live app.asar already carries the current patch');
    return { status: 'current' };
  }
  if (!autoRestart) return { status: 'auto_restart_disabled' };

  const liveStat = realFs.statSync(paths.asar);
  const signature = `${staged.stagedState.desktopVersion ?? 'unknown'}:${liveStat.size}:${Math.trunc(liveStat.mtimeMs)}`;
  const budget = autoRestartBudget(paths, signature);
  if (budget.exhausted) {
    log(`auto-restart skipped: ${budget.attempts} attempts already spent on ${signature}; patch stays staged`);
    return { status: 'auto_restart_exhausted', signature, attempts: budget.attempts };
  }
  const next = recordAutoRestart(paths, budget);
  log(`installing patch by restarting the app (auto-restart ${next.attempts}/${MAX_AUTO_RESTARTS})`);
  launchHelper({ script: HELPER_SCRIPT, paths, staged: staged.staged, log, expected: staged.expected });
  return { status: 'restarting', signature, attempts: next.attempts };
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
        ensureInstalled(paths, log);
      } catch (error) {
        log(`startup self-heal failed: ${String(error?.message ?? error)}`);
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
