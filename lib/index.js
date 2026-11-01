import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { desktopPaths } from './desktop.js';
import { createLogger, readTail } from './log.js';
import { helperScript, launchHelper } from './helper.js';
import { buildPatchedAsar, inspectPatchState } from './patch.js';
import {
  compareVersions,
  downloadAsset,
  fetchLatestRelease,
  installFromDirectory,
  prepareTarball,
  satisfiesRange,
} from './update.js';

// The engine-range parser is the guard's testing seam; keep it reachable from
// the package entry alongside the rest of the host API.
export { satisfiesRange };

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

/**
 * Send the reply first, then run `after`. The restart trigger has to stay behind
 * the response: the patched app relaunches a moment after the trigger file
 * appears, and a reply that is still in flight would surface as a network error.
 */
function replyAfterResponse(res, status, body, after, log) {
  reply(res, status, body);
  setImmediate(() => {
    try {
      after();
    } catch (error) {
      log(`post-response action failed: ${String(error?.message ?? error)}`);
    }
  });
}

function statOrNull(file) {
  try {
    const stat = realFs.statSync(file);
    return { bytes: stat.size, mtime: stat.mtime.toISOString(), mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

function readFileOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readJsonOrNull(file) {
  try {
    return JSON.parse(readFileOrNull(file));
  } catch {
    return null;
  }
}

/**
 * Marker written by a finished self-update. Older path maps (tests) predate the
 * key, so an absent key simply means "no update pending".
 */
function readUpdatePending(paths) {
  return paths.updatePending ? readJsonOrNull(paths.updatePending) : null;
}

/** Patch state of an archive, or null when the file does not exist. */
function readStateIfExists(file) {
  if (!fs.existsSync(file)) return null;
  return inspectPatchState(file);
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
/** A restart keeps the route latched for this long; the app is replaced meanwhile. */
const RESTART_LATCH_MS = 15_000;

/**
 * Auto-restart budget for one installed DSH build. The signature changes as soon
 * as DSH is updated, so an update gets a fresh budget while a patch that keeps
 * failing cannot put the app into a restart loop.
 *
 * A guard file that exists but cannot be parsed is treated as exhausted instead
 * of empty: "0 attempts" would re-arm the loop on every boot, which is exactly
 * the failure the guard exists to prevent.
 */
export function autoRestartBudget(paths, signature) {
  const raw = readFileOrNull(paths.restartGuard);
  if (raw === null) return { signature, attempts: 0, exhausted: false, corrupt: false };
  let guard = null;
  try {
    guard = JSON.parse(raw);
  } catch {
    guard = null;
  }
  if (guard === null || typeof guard !== 'object' || Array.isArray(guard)) {
    return { signature, attempts: MAX_AUTO_RESTARTS, exhausted: true, corrupt: true };
  }
  const attempts =
    guard.signature === signature && Number.isInteger(guard.attempts) ? guard.attempts : 0;
  return { signature, attempts, exhausted: attempts >= MAX_AUTO_RESTARTS, corrupt: false };
}

function recordAutoRestart(paths, budget) {
  fs.mkdirSync(paths.staging, { recursive: true });
  const next = { signature: budget.signature, attempts: budget.attempts + 1, at: new Date().toISOString() };
  fs.writeFileSync(paths.restartGuard, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/**
 * Record what the pristine backup really is. Without this file the backup is
 * just "an archive without our marker", which is also what a build patched by
 * another plugin looks like.
 */
function writeBackupMeta(paths, bytes, state) {
  if (!paths.backupMeta) return;
  const meta = {
    bytes,
    desktopVersion: state.desktopVersion ?? null,
    mainSha256: state.mainSha256 ?? null,
    accountSha256: state.accountSha256 ?? null,
    at: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(paths.backupMeta, `${JSON.stringify(meta, null, 2)}\n`);
  } catch {
    // The backup itself is still valid; the metadata is an aid, not a requirement.
  }
}

/**
 * Detect an app.asar that was modified by something other than this plugin.
 *
 * Several plugins in the ecosystem rewrite the same archive (mostly lib/main.js),
 * and the swap replaces the whole file. Our own markers cannot see those edits,
 * so the archive size is compared against a known baseline: the archive we
 * installed for a patched live file, and the pristine backup for an unpatched one
 * of the same desktop build.
 *
 * The check is a size comparison, so an equal-size repack is not detected. It is
 * meant to catch the realistic case, not to be a signature.
 */
export function detectForeignPatch(paths, { liveState = null } = {}) {
  const liveStat = statOrNull(paths.asar);
  if (liveStat === null) return { detected: false, liveBytes: null, baselineBytes: null, reason: 'live_archive_unreadable' };
  const state = liveState ?? inspectPatchState(paths.asar);
  if (!state.readable) return { detected: false, liveBytes: liveStat.bytes, baselineBytes: null, reason: 'live_archive_unreadable' };

  const staged = statOrNull(paths.stagedAsar);
  if (state.mainPatched || state.accountPatched) {
    // Half-patched archives included: any of our markers means the archive is ours
    // to begin with, so only an edit after the install is suspicious.
    const record = readJsonOrNull(paths.installRecord);
    if (record !== null && Number.isInteger(record.bytes)) {
      if (liveStat.bytes === record.bytes) {
        return { detected: false, liveBytes: liveStat.bytes, baselineBytes: record.bytes, reason: 'matches_install_record' };
      }
      return {
        detected: true,
        liveBytes: liveStat.bytes,
        baselineBytes: record.bytes,
        reason: 'live_archive_differs_from_the_install_record',
      };
    }
    // Older installs predate the record; without it there is no baseline that
    // survives a plugin update, so a rebuild must stay possible.
    return { detected: false, liveBytes: liveStat.bytes, baselineBytes: staged === null ? null : staged.bytes, reason: 'no_install_record' };
  }

  const backupStat = statOrNull(paths.backup);
  const backupState = readStateIfExists(paths.backup);
  if (backupStat === null || backupState === null || !backupState.readable) {
    return { detected: false, liveBytes: liveStat.bytes, baselineBytes: null, reason: 'no_baseline' };
  }
  if ((backupState.desktopVersion ?? null) !== (state.desktopVersion ?? null)) {
    // A DSH update: the backup belongs to the previous build, nothing to compare.
    return { detected: false, liveBytes: liveStat.bytes, baselineBytes: null, reason: 'desktop_version_changed' };
  }
  if (liveStat.bytes === backupStat.bytes) {
    return { detected: false, liveBytes: liveStat.bytes, baselineBytes: backupStat.bytes, reason: 'matches_pristine_backup' };
  }
  return {
    detected: true,
    liveBytes: liveStat.bytes,
    baselineBytes: backupStat.bytes,
    reason: 'live_archive_differs_from_the_pristine_backup',
  };
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
    foreignPatch: detectForeignPatch(paths, { liveState: state }),
    update: { currentVersion: PACKAGE_VERSION, pending: readUpdatePending(paths) },
    autoRestart: { limit: MAX_AUTO_RESTARTS, guard: readJsonOrNull(paths.restartGuard) },
    helper: { log: readTail(paths.helperLog, 5) },
  };
}

/**
 * Which archive the next patch is built from.
 *
 * The live archive wins whenever it is a pristine copy of the build that is
 * actually installed. Rebuilding from the backup first would undo a DSH update:
 * after an upgrade the backup still holds the previous build, and patching it
 * would replace the new app.asar with the old one. The backup is only the source
 * when the live archive already carries our patch and a pristine base is needed.
 */
export function choosePatchSource({ liveState, backupState }) {
  if (!liveState?.readable) return backupState?.readable ? 'backup' : null;
  if (!liveState.mainPatched && !liveState.accountPatched) return 'live';
  return backupState?.readable ? 'backup' : 'live';
}

/**
 * Keep the pristine backup in sync with the installed build. Only a verified
 * unpatched live archive is ever copied here, so a patched archive can never
 * overwrite the pristine base that rollback and re-patching depend on.
 *
 * Returns true when a new backup was written.
 */
export function ensureBackupFresh(paths, liveState, liveStat, log) {
  if (!liveState?.readable || liveState.mainPatched || liveState.accountPatched) return false;
  const backupState = readStateIfExists(paths.backup);
  const fresh =
    backupState !== null &&
    backupState.readable &&
    !backupState.mainPatched &&
    !backupState.accountPatched &&
    backupState.mainSha256 === liveState.mainSha256 &&
    backupState.accountSha256 === liveState.accountSha256;
  if (fresh) return false;

  const tmp = `${paths.backup}.tmp`;
  try {
    realFs.copyFileSync(paths.asar, tmp);
    const copied = realFs.statSync(tmp);
    if (copied.size !== liveStat.bytes) throw new Error(`copy has ${copied.size} bytes, expected ${liveStat.bytes}`);
    const copiedState = inspectPatchState(tmp);
    if (!copiedState.readable || copiedState.mainPatched || copiedState.accountPatched) {
      throw new Error('copied archive is not a readable pristine archive');
    }
    realFs.renameSync(tmp, paths.backup);
    writeBackupMeta(paths, copied.size, copiedState);
    log(`refreshed pristine backup from the installed build (${copied.size} bytes)`);
    return true;
  } catch (error) {
    try {
      realFs.unlinkSync(tmp);
    } catch {
      // The temporary file may not exist; nothing to clean up.
    }
    log(`keeping the existing backup: ${String(error?.message ?? error)}`);
    return false;
  }
}

/**
 * Build (or reuse) the patched archive for the installed app.asar. The staged
 * file is written to a temporary path and renamed, so a failed build never
 * destroys a previously staged archive that the helper may still take.
 *
 * Returns null when nothing can be staged, otherwise:
 *   {staged, built, expected, state, stagedState, source:{path,size,pristine}}
 * `expected` is the signature of the live archive the helper re-checks right
 * before swapping, so a DSH update during the wait aborts the install.
 */
export function ensureStaged(paths, log) {
  const liveStat = statOrNull(paths.asar);
  if (liveStat === null) {
    log(`live archive is not readable: ${paths.asar}`);
    return null;
  }
  const liveState = inspectPatchState(paths.asar);
  if (!liveState.readable) log(`live archive is not a readable asar: ${String(liveState.error ?? 'unknown error')}`);
  const backupState = readStateIfExists(paths.backup);
  const sourceName = choosePatchSource({ liveState, backupState });
  if (sourceName === null) {
    log('no readable asar archive to build a patch from');
    return null;
  }
  if (
    sourceName === 'backup' &&
    liveState.readable &&
    backupState !== null &&
    backupState.readable &&
    (backupState.desktopVersion ?? null) !== (liveState.desktopVersion ?? null)
  ) {
    log(
      `refusing to patch from the backup: it holds desktop ${backupState.desktopVersion ?? 'unknown'} but the installed build is ${liveState.desktopVersion ?? 'unknown'}`,
    );
    return null;
  }
  if (sourceName === 'live') {
    if (detectForeignPatch(paths, { liveState }).detected) {
      // Never bake somebody else's patch into the pristine base.
      log('keeping the existing backup: the live archive carries changes this plugin did not make');
    } else {
      ensureBackupFresh(paths, liveState, liveStat, log);
    }
  }

  const source = sourceName === 'live' ? paths.asar : paths.backup;
  const sourceStat = sourceName === 'live' ? liveStat : statOrNull(source);
  if (sourceStat === null) {
    log(`patch source is not readable: ${source}`);
    return null;
  }
  const sourceState = sourceName === 'live' ? liveState : backupState;
  const pristineLive = sourceName === 'live' && !liveState.mainPatched && !liveState.accountPatched;
  fs.mkdirSync(paths.staging, { recursive: true });
  const meta = {
    plugin: PACKAGE_VERSION,
    source,
    sourceSize: sourceStat.bytes,
    sourceMtimeMs: sourceStat.mtimeMs,
    // Source and target are recorded separately on purpose: with source=backup the
    // two archives have different sizes, and only expected* describe the file the
    // helper is about to replace. The helper re-checks the live archive itself.
    expected: paths.asar,
    expectedSize: liveStat.bytes,
    expectedMtimeMs: liveStat.mtimeMs,
    // Kept for the status payload; the helper re-checks the live archive itself.
    size: liveStat.bytes,
    mtimeMs: liveStat.mtimeMs,
    desktopVersion: sourceState?.desktopVersion ?? null,
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
    } catch (error) {
      log(`discarding the staged archive: ${String(error?.message ?? error)}`);
      return null;
    }
  };

  let built = false;
  let reused = reuseStaged();
  if (reused === null) {
    log(`building patched app.asar from ${source}`);
    const buildTarget = `${paths.stagedAsar}.tmp`;
    try {
      const result = buildPatchedAsar(source, buildTarget, { log });
      if (result.patchedAsar === null) {
        log('source asar is already patched; nothing to stage');
        return null;
      }
      const builtState = inspectPatchState(buildTarget);
      if (!isComplete(builtState)) throw new Error('built archive is missing patch features');
      realFs.renameSync(buildTarget, paths.stagedAsar);
      reused = { stagedState: builtState };
      built = true;
      log(`staged patched asar: ${paths.stagedAsar} (${result.bytes} bytes)`);
    } catch (error) {
      try {
        realFs.unlinkSync(buildTarget);
      } catch {
        // The build may have failed before creating the temporary file.
      }
      throw error;
    }
  } else {
    log('reusing staged patched asar');
    // Keep the original build time: the archive itself did not change.
    meta.builtAt = reused.builtAt ?? meta.builtAt;
  }
  // Refresh the metadata even on reuse: expected* and the live archive size move
  // independently, and a stale status payload is how a wrong freshness check went
  // unnoticed before.
  fs.writeFileSync(paths.stagedMeta, `${JSON.stringify(meta, null, 2)}\n`);

  return {
    staged: paths.stagedAsar,
    built,
    expected: { size: meta.expectedSize, mtimeMs: meta.expectedMtimeMs },
    state: liveState,
    stagedState: reused.stagedState,
    source: { path: source, size: meta.sourceSize, pristine: pristineLive },
  };
}

/**
 * Make the live archive carry the current patch. DSH keeps app.asar open without
 * FILE_SHARE_DELETE, so the archive can never be replaced while the app runs, and
 * a helper that waits for a later exit is torn down before it can act. The only
 * verified path is the short-lived restart helper: stop the app, swap the archive,
 * start it again. That happens once after a DSH update, guarded against loops.
 */
export function ensureInstalled(paths, log, { autoRestart = true, launch = launchHelper } = {}) {
  fs.mkdirSync(paths.staging, { recursive: true });
  // A marker that matches the version this process loaded proves the restart
  // finished the self-update; keep it only while the installed files are older.
  const pendingUpdate = readUpdatePending(paths);
  if (pendingUpdate !== null && pendingUpdate.version === PACKAGE_VERSION) {
    try {
      fs.unlinkSync(paths.updatePending);
      log(`self-update finished: now running ${PACKAGE_VERSION}`);
    } catch (error) {
      log(`could not clear the self-update marker: ${String(error?.message ?? error)}`);
    }
  }
  const foreign = detectForeignPatch(paths);
  if (foreign.detected) {
    log(
      `not touching the installed archive: it differs from the known baseline (${foreign.liveBytes} vs ${foreign.baselineBytes} bytes, ${foreign.reason}). ` +
        'Another plugin probably patched app.asar; delete the staging directory to force a rebuild.',
    );
    return { status: 'foreign_patch_detected', foreignPatch: foreign };
  }
  const staged = ensureStaged(paths, log);
  if (staged === null) {
    log('nothing to stage: the live archive is already patched or no source is available');
    return { status: 'nothing_to_stage' };
  }
  if (isCurrent(staged.state, staged.stagedState)) {
    log('live app.asar already carries the current patch');
    return { status: 'current' };
  }
  if (!autoRestart) return { status: 'auto_restart_disabled' };

  // The signature identifies the installed DSH build, not the archive that is
  // live right now. Installing the patch changes the live size, and a live-size
  // signature would hand the same build a fresh budget on the next boot.
  const signature = `${staged.stagedState.desktopVersion ?? 'unknown'}:${staged.source.size}`;
  const budget = autoRestartBudget(paths, signature);
  if (budget.corrupt) {
    log(`auto-restart disabled: ${paths.restartGuard} is unreadable; delete it to re-enable self-heal`);
    return { status: 'auto_restart_guard_corrupt' };
  }
  if (budget.exhausted) {
    log(`auto-restart skipped: ${budget.attempts} attempts already spent on ${signature}; the patch stays staged`);
    return { status: 'auto_restart_exhausted', signature, attempts: budget.attempts };
  }
  const next = recordAutoRestart(paths, budget);
  log(`installing patch by restarting the app (auto-restart ${next.attempts}/${MAX_AUTO_RESTARTS})`);
  launch({
    script: HELPER_SCRIPT,
    paths,
    staged: staged.staged,
    log,
    expected: staged.expected,
    createBackup: staged.source.pristine,
  });
  return { status: 'restarting', signature, attempts: next.attempts };
}

/** Reject cross-site browser requests: the restart route must stay local. */
function sameOrigin(req) {
  const site = req.headers?.['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false;
  return true;
}

/**
 * Handler for POST /dsh-retry/restart. Extracted from apply() so the ordering and
 * status-code behaviour can be tested without a live web server.
 */
export function createRestartHandler({ launch = launchHelper, logger = createLogger } = {}) {
  const restarting = { value: false };

  const releaseAfter = (ms) => {
    const timer = setTimeout(() => {
      restarting.value = false;
    }, ms);
    timer.unref?.();
  };

  const handler = async (req, res, paths) => {
    if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
    if (!sameOrigin(req)) return reply(res, 403, { ok: false, error: 'cross_origin_request' });
    if (restarting.value) return reply(res, 409, { ok: false, error: 'restart_in_progress' });
    const log = logger(paths.buildLog);
    // The helper restarts the app with the archive it was given; after a
    // self-update the plugin files on disk already changed, so swapping the
    // archive under the old modules would mix two plugin versions.
    if (readUpdatePending(paths) !== null) {
      log('restart refused: a self-update is waiting for a full app restart');
      return reply(res, 409, { ok: false, error: 'update_pending', detail: 'update installed; restart the app to finish' });
    }
    restarting.value = true;
    let holdsLock = false;
    try {
      if (!canWriteResources(paths)) {
        return reply(res, 503, { ok: false, error: 'resources_not_writable' });
      }
      const state = inspectPatchState(paths.asar);
      const force = typeof req.url === 'string' && /(?:^|[?&])force=1(?:&|$)/.test(req.url);
      const foreign = detectForeignPatch(paths, { liveState: state });
      if (foreign.detected && !force) {
        log(`restart refused: the installed archive carries changes from another plugin (${foreign.reason})`);
        return reply(res, 409, { ok: false, error: 'foreign_patch_detected', detail: foreign.reason });
      }
      if (foreign.detected) log(`restart forced over a foreign patch (${foreign.reason})`);
      const staged = ensureStaged(paths, log);
      if (isPatched(state) && (staged === null || isCurrent(state, staged.stagedState))) {
        log('restart requested with an up-to-date patch');
        holdsLock = true;
        replyAfterResponse(
          res,
          200,
          { ok: true, mode: 'restart' },
          () => {
            try {
              fs.writeFileSync(paths.trigger, `${new Date().toISOString()}\n`);
            } catch (error) {
              restarting.value = false;
              throw error;
            }
          },
          log,
        );
        releaseAfter(RESTART_LATCH_MS);
        return;
      }
      if (staged === null) {
        log('restart requested but no patch could be staged');
        return reply(res, 500, { ok: false, error: 'nothing_to_install' });
      }
      log(`restart requested with a pending patch (${staged.source.path})`);
      holdsLock = true;
      launch({
        script: HELPER_SCRIPT,
        paths,
        staged: staged.staged,
        log,
        expected: staged.expected,
        createBackup: staged.source.pristine,
      });
      releaseAfter(RESTART_LATCH_MS);
      return reply(res, 202, { ok: true, mode: 'patch-and-restart', staged: staged.staged });
    } catch (error) {
      log(`restart failed: ${String(error?.stack ?? error)}`);
      if (res.headersSent !== true) {
        return reply(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
      res.end();
    } finally {
      // A started restart stays latched: the process is about to be replaced and
      // releasing the lock would let a second helper race the first one.
      if (!holdsLock) restarting.value = false;
    }
  };

  return { handler, restarting };
}

/** A finished self-update latches the route; the app has to restart anyway. */
const UPDATE_LATCH_MS = 60_000;

/**
 * Refuse an update whose published engines the running app cannot satisfy.
 *
 * A range this code cannot parse is allowed with a log line: wrongly blocking a
 * good update is worse than accepting one the user can still reinstall over.
 * Without a desktop version there is nothing to compare against, so the check is
 * skipped instead of failing closed.
 */
function checkEngineCompatibility(paths, manifest, log) {
  const engines = manifest?.engines;
  if (engines === null || typeof engines !== 'object' || Array.isArray(engines)) return null;
  const state = inspectPatchState(paths.asar);
  const desktopVersion = state.desktopVersion ?? null;
  if (desktopVersion === null) {
    log('skipping engine check: desktop version is unavailable');
    return null;
  }
  for (const [engine, actual] of [
    ['dsh', desktopVersion],
    ['node', process.versions.node],
  ]) {
    const range = engines[engine];
    if (range === undefined || range === null || range === '') continue;
    const satisfied = satisfiesRange(actual, range);
    if (satisfied === null) {
      log(`could not verify engine compatibility: ${range}`);
      continue;
    }
    if (!satisfied) return { range, actual };
  }
  return null;
}

/**
 * Handlers for /dsh-retry/update. Extracted from apply() so the status codes and
 * the install/marker order can be tested without a live web server.
 */
export function createUpdateHandlers({
  root = PACKAGE_ROOT,
  fetchImpl = fetch,
  fetchLatest = fetchLatestRelease,
  prepare = prepareTarball,
  install = installFromDirectory,
  logger = createLogger,
  tmpDir = os.tmpdir(),
} = {}) {
  const updating = { value: false };

  const releaseAfter = (ms) => {
    const timer = setTimeout(() => {
      updating.value = false;
    }, ms);
    timer.unref?.();
  };

  const check = async () => {
    try {
      return { latest: await fetchLatest({ fetchImpl }), error: null };
    } catch (error) {
      return { latest: null, error: String(error?.message ?? error) };
    }
  };

  const status = async (req, res) => {
    if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
    const { latest, error } = await check();
    const body = {
      ok: true,
      current: { version: PACKAGE_VERSION },
      latest,
      updateAvailable: latest !== null && compareVersions(latest.version, PACKAGE_VERSION) > 0,
    };
    // A failed lookup is a normal state, not a server error: the button should
    // still render and show the reason.
    if (error !== null) body.error = error;
    return reply(res, 200, body);
  };

  const updateNow = async (req, res, paths) => {
    if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
    if (!sameOrigin(req)) return reply(res, 403, { ok: false, error: 'cross_origin_request' });
    if (paths == null) return reply(res, 409, { ok: false, error: 'not_desktop' });
    if (updating.value) return reply(res, 409, { ok: false, error: 'update_in_progress' });
    updating.value = true;
    const log = logger(paths.buildLog);
    let holdsLock = false;
    try {
      const { latest, error } = await check();
      if (latest === null) throw new Error(error ?? 'could not check for updates');
      log(`update check: current=${PACKAGE_VERSION} latest=${latest.version}`);
      if (compareVersions(latest.version, PACKAGE_VERSION) <= 0) {
        log(`update skipped: ${latest.version} is not newer than ${PACKAGE_VERSION}`);
        return reply(res, 200, { ok: true, updateAvailable: false, current: { version: PACKAGE_VERSION } });
      }
      if (latest.asset === null) throw new Error(`release ${latest.tag} has no .tgz asset`);
      const tarball = path.join(tmpDir, `dsh-retry-${latest.version}.tgz`);
      log(`downloading ${latest.asset.url} -> ${tarball}`);
      await downloadAsset({
        url: latest.asset.url,
        destPath: tarball,
        size: latest.asset.size,
        digest: latest.asset.digest,
        fetchImpl,
      });
      const prepared = prepare({ tarball, log });
      try {
        const incompatible = checkEngineCompatibility(paths, prepared.manifest, log);
        if (incompatible !== null) {
          log(`update refused: ${incompatible.range} is incompatible with ${incompatible.actual}`);
          return reply(res, 409, {
            ok: false,
            error: 'incompatible_update',
            detail: `${incompatible.range} vs ${incompatible.actual}`,
          });
        }
        log(`installing dsh-retry ${latest.version} into ${root}`);
        const installed = install({ sourceDir: prepared.sourceDir, root, log });
        fs.mkdirSync(paths.staging, { recursive: true });
        fs.writeFileSync(
          paths.updatePending,
          `${JSON.stringify({ version: installed.version, installedAt: new Date().toISOString() }, null, 2)}\n`,
        );
        log(`installed dsh-retry ${installed.version}; a full app restart is required`);
        holdsLock = true;
        releaseAfter(UPDATE_LATCH_MS);
        return reply(res, 200, {
          ok: true,
          installed: { from: PACKAGE_VERSION, to: installed.version },
          restartRequired: true,
        });
      } finally {
        prepared.cleanup?.();
      }
    } catch (error) {
      log(`update failed: ${String(error?.stack ?? error)}`);
      return reply(res, 502, { ok: false, error: 'update_failed', detail: String(error?.message ?? error) });
    } finally {
      // Only a completed install keeps the latch: a failed one must be retryable.
      if (!holdsLock) updating.value = false;
    }
  };

  const handler = (req, res, paths) => (req.method === 'GET' ? status(req, res, paths) : updateNow(req, res, paths));

  return { handler, status, updating };
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const { handler: restart } = createRestartHandler();
  const { handler: update } = createUpdateHandlers();

  ctx.effect(() => {
    const paths = desktopPaths();
    if (paths === null) return;
    const log = createLogger(paths.buildLog);
    const timer = setTimeout(() => {
      try {
        ensureInstalled(paths, log);
      } catch (error) {
        log(`startup self-heal failed: ${String(error?.stack ?? error)}`);
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
      path: '/dsh-retry/update',
      handler: safeRoute(update),
    }),
  );

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-retry/prepare',
      handler: safeRoute(async (req, res, paths) => {
        if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
        if (!sameOrigin(req)) return reply(res, 403, { ok: false, error: 'cross_origin_request' });
        if (!canWriteResources(paths)) return reply(res, 503, { ok: false, error: 'resources_not_writable' });
        const log = createLogger(paths.buildLog);
        const state = inspectPatchState(paths.asar);
        const staged = ensureStaged(paths, log);
        if (staged === null) return reply(res, 200, { ok: true, patched: isPatched(state), staged: null });
        const stagedStat = statOrNull(staged.staged);
        return reply(res, 200, {
          ok: true,
          patched: isPatched(state),
          current: isCurrent(state, staged.stagedState),
          staged: { path: staged.staged, bytes: stagedStat?.bytes ?? null, built: staged.built },
        });
      }),
    }),
  );

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-retry/restart',
      handler: safeRoute(restart),
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
      // A thrown handler must leave a trace: the previous version swallowed the
      // exception and the only symptom was a button that silently did nothing.
      createLogger(paths.buildLog)(`route failed: ${String(error?.stack ?? error)}`);
      if (res.headersSent === true) {
        res.end();
        return;
      }
      return reply(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  };
}