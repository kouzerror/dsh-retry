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

function reply(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

function statOrNull(file) {
  try {
    const stat = fs.statSync(file);
    return { bytes: stat.size, mtime: stat.mtime.toISOString() };
  } catch {
    return null;
  }
}

/** Public status payload; kept pure so tests can exercise it without a server. */
export function statusPayload(paths, log = () => {}) {
  const state = inspectPatchState(paths.asar);
  const staged = statOrNull(paths.stagedAsar);
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
    staged: staged === null ? null : { path: paths.stagedAsar, ...staged },
    backup: { path: paths.backup, exists: statOrNull(paths.backup) !== null },
    helper: { log: readTail(paths.helperLog, 5) },
  };
}

/**
 * Build (or reuse) the patched archive for the installed app.asar.
 * Returns null when the live archive is already patched.
 */
export function ensureStaged(paths, log) {
  if (isPatched(inspectPatchState(paths.asar))) return null;
  fs.mkdirSync(paths.staging, { recursive: true });
  const sourceStat = fs.statSync(paths.asar);
  const meta = {
    plugin: PACKAGE_VERSION,
    source: paths.asar,
    size: sourceStat.size,
    mtimeMs: sourceStat.mtimeMs,
    builtAt: new Date().toISOString(),
  };
  if (fs.existsSync(paths.stagedAsar) && fs.existsSync(paths.stagedMeta)) {
    try {
      const previous = JSON.parse(fs.readFileSync(paths.stagedMeta, 'utf8'));
      const reusable =
        previous.plugin === meta.plugin &&
        previous.source === meta.source &&
        previous.size === meta.size &&
        previous.mtimeMs === meta.mtimeMs &&
        isPatched(inspectPatchState(paths.stagedAsar));
      if (reusable) {
        log('reusing staged patched asar');
        return { staged: paths.stagedAsar, built: false };
      }
    } catch {
      // fall through to a fresh build
    }
  }
  log('building patched app.asar');
  buildPatchedAsar(paths.asar, paths.stagedAsar, { log });
  fs.writeFileSync(paths.stagedMeta, `${JSON.stringify(meta, null, 2)}\n`);
  log(`staged patched asar: ${paths.stagedAsar}`);
  return { staged: paths.stagedAsar, built: true };
}

/**
 * Before the core patch exists there are no restart entries to click. Arm one
 * helper per app run; it installs the patch when the app closes normally and
 * never touches the archive while DSH is running.
 */
export function armInstallOnExit(paths, log) {
  if (isPatched(inspectPatchState(paths.asar))) return false;
  fs.mkdirSync(paths.staging, { recursive: true });
  try {
    const previous = JSON.parse(fs.readFileSync(paths.marker, 'utf8'));
    if (previous.mainPid === process.ppid) return false;
  } catch {
    // no marker yet
  }
  const staged = ensureStaged(paths, log)?.staged ?? null;
  if (staged === null) return false;
  launchHelper({ script: HELPER_SCRIPT, paths, staged, log, installOnly: true });
  fs.writeFileSync(paths.marker, `${JSON.stringify({ mainPid: process.ppid, armedAt: new Date().toISOString() }, null, 2)}\n`);
  return true;
}

/** Wrap a handler so every route rejects non-desktop hosts with 409. */
function desktopRoute(handler) {
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
      handler: desktopRoute(async (req, res, paths) => reply(res, 200, statusPayload(paths))),
    }),
  );

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-retry/prepare',
      handler: desktopRoute(async (req, res, paths) => {
        const log = createLogger(paths.buildLog);
        const state = inspectPatchState(paths.asar);
        if (isPatched(state)) return reply(res, 200, { ok: true, patched: true, staged: null });
        const staged = ensureStaged(paths, log);
        return reply(res, 200, {
          ok: true,
          patched: false,
          staged: { path: staged.staged, bytes: fs.statSync(staged.staged).size, built: staged.built },
        });
      }),
    }),
  );

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-retry/restart',
      handler: desktopRoute(async (req, res, paths) => {
        if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
        if (restarting.value) return reply(res, 409, { ok: false, error: 'restart_in_progress' });
        restarting.value = true;
        const log = createLogger(paths.buildLog);
        try {
          const staged = ensureStaged(paths, log);
          if (staged === null) {
            reply(res, 200, { ok: true, mode: 'restart' });
            log('writing restart trigger');
            fs.writeFileSync(paths.trigger, `${new Date().toISOString()}\n`);
            return;
          }
          reply(res, 200, { ok: true, mode: 'patch-and-restart', staged: staged.staged });
          launchHelper({ script: HELPER_SCRIPT, paths, staged: staged.staged, log });
        } catch (error) {
          restarting.value = false;
          log(`restart failed: ${String(error?.message ?? error)}`);
          return reply(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }),
    }),
  );
}
