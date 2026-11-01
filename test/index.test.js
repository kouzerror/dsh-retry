import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  autoRestartBudget,
  canWriteResources,
  choosePatchSource,
  ensureBackupFresh,
  ensureInstalled,
  ensureStaged,
  statusPayload,
} from '../lib/index.js';
import { createLogger, readTail } from '../lib/log.js';
import { ACCOUNT_ENTRY, MAIN_ENTRY, inspectPatchState, patchMain } from '../lib/patch.js';
import { writeAsar } from './fixtures/write-asar.mjs';
import {
  bundleFiles,
  pristineAccount,
  pristineMain,
  writePatchedAsar,
  writePristineAsar,
} from './fixtures/pristine-bundle.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-retry-index-'));

/** Same shape as lib/desktop.js desktopPaths(), pointed at a throwaway directory. */
function makePaths() {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  const resources = path.join(dir, 'resources');
  const staging = path.join(resources, 'dsh-retry-build');
  fs.mkdirSync(staging, { recursive: true });
  return {
    exe: path.join(dir, 'DeepSeek Harness.exe'),
    resources,
    asar: path.join(resources, 'app.asar'),
    backup: path.join(resources, 'app.asar.dsh-retry.bak'),
    trigger: path.join(resources, 'dsh-retry.restart'),
    staging,
    stagedAsar: path.join(staging, 'app.asar.patched'),
    stagedMeta: path.join(staging, 'app.asar.patched.meta.json'),
    restartGuard: path.join(staging, 'restart-guard.json'),
    helperLog: path.join(staging, 'restart-helper.log'),
    buildLog: path.join(staging, 'restart.log'),
  };
}

function silentLog() {
  const lines = [];
  const log = (message) => lines.push(String(message));
  log.lines = lines;
  return log;
}

function liveSignature(paths) {
  const stat = fs.statSync(paths.asar);
  return { bytes: stat.size, mtimeMs: stat.mtimeMs };
}

test('createLogger returns a callable logger that appends to its file', () => {
  const paths = makePaths();
  const log = createLogger(paths.buildLog);
  assert.equal(typeof log, 'function');
  assert.equal(log.file, paths.buildLog);
  log('first line');
  log.write('second line');
  const tail = readTail(paths.buildLog, 5);
  assert.equal(tail.length, 2);
  assert.match(tail[0], /first line$/);
  assert.match(tail[1], /second line$/);
});

test('readTail keeps the last lines and strips CRLF endings', () => {
  const paths = makePaths();
  // PowerShell's Add-Content writes CRLF while this module writes LF.
  fs.writeFileSync(paths.buildLog, 'one\r\ntwo\r\nthree\r\n');
  assert.deepEqual(readTail(paths.buildLog, 2), ['two', 'three']);
  assert.deepEqual(readTail(paths.buildLog, 10), ['one', 'two', 'three']);
  assert.deepEqual(readTail(path.join(paths.staging, 'absent.log'), 3), []);
});

test('statusPayload describes an unpatched live archive and its staged metadata', () => {
  const paths = makePaths();
  writePristineAsar(paths.asar, { version: '0.3.0' });
  fs.writeFileSync(paths.stagedAsar, 'staged');
  fs.writeFileSync(
    paths.stagedMeta,
    JSON.stringify({ desktopVersion: '0.3.0', builtAt: 'built-at', size: 1234, mtimeMs: 99 }),
  );

  const status = statusPayload(paths);
  assert.equal(status.ok, true);
  assert.equal(status.plugin.name, 'dsh-retry');
  assert.equal(status.desktopVersion, '0.3.0');
  assert.equal(status.patched, false);
  assert.deepEqual(status.missing.main, ['enLabel', 'zhLabel', 'trayItem', 'watcher']);
  assert.deepEqual(status.missing.account, ['item', 'handler', 'enLabel', 'zhLabel']);
  assert.equal(status.staged.path, paths.stagedAsar);
  assert.equal(status.staged.bytes, 6);
  assert.equal(status.staged.meta.builtAt, 'built-at');
  assert.equal(status.writeAccess, true);
  assert.equal(status.backup.exists, false);
  assert.equal(status.autoRestart.limit, 2);
  assert.deepEqual(status.helper.log, []);
});

test('statusPayload reports a patched archive and a truthy writeAccess flag', () => {
  const paths = makePaths();
  writePatchedAsar(paths.asar);
  const status = statusPayload(paths);
  assert.equal(status.patched, true);
  assert.deepEqual(status.missing, { main: [], account: [] });
  assert.equal(status.writeAccess, true);
});

test('autoRestartBudget only counts attempts made for the same signature', () => {
  const paths = makePaths();
  assert.deepEqual(autoRestartBudget(paths, 'sig-a'), {
    signature: 'sig-a',
    attempts: 0,
    exhausted: false,
    corrupt: false,
  });

  fs.writeFileSync(paths.restartGuard, JSON.stringify({ signature: 'sig-a', attempts: 1, at: 'x' }));
  assert.deepEqual(autoRestartBudget(paths, 'sig-a'), {
    signature: 'sig-a',
    attempts: 1,
    exhausted: false,
    corrupt: false,
  });
  assert.deepEqual(autoRestartBudget(paths, 'sig-b'), {
    signature: 'sig-b',
    attempts: 0,
    exhausted: false,
    corrupt: false,
  });

  fs.writeFileSync(paths.restartGuard, JSON.stringify({ signature: 'sig-a', attempts: 2, at: 'x' }));
  assert.equal(autoRestartBudget(paths, 'sig-a').exhausted, true);
});

test('autoRestartBudget fails closed when the guard exists but is not a guard', () => {
  const paths = makePaths();
  // "0 attempts" would re-arm the restart loop on every boot, so an unreadable
  // guard must read as exhausted instead of empty.
  for (const broken of ['{ not json', 'null', '[]', '"text"']) {
    fs.writeFileSync(paths.restartGuard, broken);
    assert.deepEqual(autoRestartBudget(paths, 'sig-a'), {
      signature: 'sig-a',
      attempts: 2,
      exhausted: true,
      corrupt: true,
    });
  }
});

test('choosePatchSource rebuilds from the installed build, not the older backup', () => {
  const pristine = { readable: true, mainPatched: false, accountPatched: false };
  const patched = { readable: true, mainPatched: true, accountPatched: true };

  assert.equal(choosePatchSource({ liveState: pristine, backupState: { readable: true } }), 'live');
  assert.equal(choosePatchSource({ liveState: pristine, backupState: null }), 'live');
  assert.equal(choosePatchSource({ liveState: patched, backupState: { readable: true } }), 'backup');
  assert.equal(choosePatchSource({ liveState: patched, backupState: null }), 'live');
  assert.equal(choosePatchSource({ liveState: { readable: false }, backupState: { readable: true } }), 'backup');
  assert.equal(choosePatchSource({ liveState: { readable: false }, backupState: null }), null);
});

test('canWriteResources reflects whether the resources directory exists', () => {
  const paths = makePaths();
  assert.equal(canWriteResources(paths), true);
  assert.equal(canWriteResources({ ...paths, asar: path.join(paths.resources, 'missing', 'app.asar') }), false);
});

test('ensureBackupFresh replaces a backup that belongs to another build', () => {
  const paths = makePaths();
  writePristineAsar(paths.asar, { version: '0.3.0' });
  // A real earlier build differs in the bundles, not only in package.json.
  writePristineAsar(paths.backup, {
    version: '0.2.1-rc.5',
    main: pristineMain().replace('restartApplication: "Restart",', 'restartApplication: "Reload",'),
  });

  const log = silentLog();
  const liveState = inspectPatchState(paths.asar);
  assert.equal(ensureBackupFresh(paths, liveState, liveSignature(paths), log), true);

  const backupState = inspectPatchState(paths.backup);
  assert.equal(backupState.desktopVersion, '0.3.0');
  assert.equal(backupState.mainSha256, liveState.mainSha256);
  assert.equal(backupState.accountSha256, liveState.accountSha256);
  assert.equal(fs.existsSync(`${paths.backup}.tmp`), false);
  assert.match(log.lines.join('\n'), /refreshed pristine backup from the installed build/);
});

test('ensureBackupFresh never copies a patched archive into the backup', () => {
  const paths = makePaths();
  writePatchedAsar(paths.asar);
  writePristineAsar(paths.backup);
  const before = fs.readFileSync(paths.backup);
  const liveState = inspectPatchState(paths.asar);

  assert.equal(ensureBackupFresh(paths, liveState, liveSignature(paths), silentLog()), false);
  assert.deepEqual(fs.readFileSync(paths.backup), before);
});

test('ensureBackupFresh leaves an already matching backup untouched', () => {
  const paths = makePaths();
  writePristineAsar(paths.asar, { version: '0.3.0' });
  fs.copyFileSync(paths.asar, paths.backup);
  const before = fs.statSync(paths.backup).mtimeMs;

  const liveState = inspectPatchState(paths.asar);
  assert.equal(ensureBackupFresh(paths, liveState, liveSignature(paths), silentLog()), false);
  assert.equal(fs.statSync(paths.backup).mtimeMs, before);
});

test('ensureStaged builds from the installed archive and records the live signature', () => {
  const paths = makePaths();
  writePristineAsar(paths.asar, { version: '0.3.0' });
  const liveState = inspectPatchState(paths.asar);
  const live = liveSignature(paths);

  const result = ensureStaged(paths, silentLog());
  assert.ok(result !== null);
  assert.equal(result.built, true);
  assert.equal(result.source.path, paths.asar);
  assert.equal(result.source.pristine, true);
  assert.equal(result.expected.size, live.bytes);
  assert.ok(Math.abs(result.expected.mtimeMs - live.mtimeMs) < 2);
  assert.equal(result.stagedState.mainPatched, true);
  assert.equal(result.stagedState.accountPatched, true);

  const meta = JSON.parse(fs.readFileSync(paths.stagedMeta, 'utf8'));
  assert.equal(meta.source, paths.asar);
  assert.equal(meta.expected, paths.asar);
  assert.equal(meta.expectedSize, live.bytes);
  assert.equal(meta.desktopVersion, '0.3.0');
  assert.equal(meta.plugin, JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  assert.equal(fs.existsSync(`${paths.stagedAsar}.tmp`), false);

  // Building from the live archive also refreshes the pristine backup.
  const backupState = inspectPatchState(paths.backup);
  assert.equal(backupState.mainSha256, liveState.mainSha256);
  assert.equal(backupState.accountSha256, liveState.accountSha256);
});

test('ensureStaged keeps source and expected separate when it patches from the backup', () => {
  const paths = makePaths();
  // The live archive already carries the patch, so the pristine base is the backup.
  writePatchedAsar(paths.asar, { version: '0.3.0' });
  writePristineAsar(paths.backup, { version: '0.3.0' });
  const live = liveSignature(paths);
  const backupBytes = fs.statSync(paths.backup).size;

  const result = ensureStaged(paths, silentLog());
  assert.ok(result !== null);
  assert.equal(result.source.path, paths.backup);
  assert.equal(result.source.pristine, false);
  assert.equal(result.expected.size, live.bytes);

  const meta = JSON.parse(fs.readFileSync(paths.stagedMeta, 'utf8'));
  assert.equal(meta.source, paths.backup);
  assert.equal(meta.expected, paths.asar);
  assert.equal(meta.sourceSize, backupBytes);
  assert.equal(meta.expectedSize, live.bytes);
  // The helper must check the archive it replaces, never the source archive.
  assert.notEqual(meta.sourceSize, meta.expectedSize);
  // Patching from the backup must not turn the backup into a patched archive.
  assert.equal(inspectPatchState(paths.backup).mainPatched, false);
});

test('ensureStaged refreshes the staged metadata when it reuses the archive', () => {
  const paths = makePaths();
  writePristineAsar(paths.asar, { version: '0.3.0' });
  const log = silentLog();
  const first = ensureStaged(paths, log);
  assert.equal(first.built, true);

  const meta = JSON.parse(fs.readFileSync(paths.stagedMeta, 'utf8'));
  fs.writeFileSync(paths.stagedMeta, JSON.stringify({ ...meta, expectedSize: 1 }));
  const reused = ensureStaged(paths, log);
  assert.equal(reused.built, false);
  assert.equal(reused.expected.size, liveSignature(paths).bytes);

  const refreshed = JSON.parse(fs.readFileSync(paths.stagedMeta, 'utf8'));
  assert.equal(refreshed.expectedSize, liveSignature(paths).bytes);
  assert.equal(refreshed.builtAt, meta.builtAt);
});

test('ensureStaged refuses to patch from a backup of another desktop build', () => {
  const paths = makePaths();
  writePatchedAsar(paths.asar, { version: '0.3.0' });
  writePristineAsar(paths.backup, { version: '0.2.1-rc.5' });
  const log = silentLog();

  assert.equal(ensureStaged(paths, log), null);
  assert.equal(fs.existsSync(paths.stagedAsar), false);
  assert.match(log.lines.join('\n'), /refusing to patch from the backup/);
});

test('ensureStaged keeps the previous staged archive when a build fails', () => {
  const paths = makePaths();
  // Readable, but it cannot produce a complete patch: the account bundle is gone.
  writeAsar(
    paths.asar,
    new Map([
      ['package.json', JSON.stringify({ name: 'deepseek-harness-desktop', version: '0.3.0' })],
      [MAIN_ENTRY, pristineMain()],
    ]),
  );
  fs.writeFileSync(paths.stagedAsar, 'previous staged archive');

  assert.throws(() => ensureStaged(paths, silentLog()), new RegExp(`missing ${ACCOUNT_ENTRY}`));
  assert.equal(fs.readFileSync(paths.stagedAsar, 'utf8'), 'previous staged archive');
  assert.equal(fs.existsSync(`${paths.stagedAsar}.tmp`), false);
});

test('ensureInstalled restarts once and gives up after two failed attempts', () => {
  const paths = makePaths();
  writePristineAsar(paths.asar, { version: '0.3.0' });
  const launches = [];
  const launch = (options) => launches.push(options);
  const log = silentLog();

  const first = ensureInstalled(paths, log, { launch });
  assert.equal(first.status, 'restarting');
  assert.equal(first.attempts, 1);
  assert.equal(launches.length, 1);
  assert.match(launches[0].script, /restart-helper\.ps1$/);
  assert.equal(launches[0].createBackup, true);
  assert.equal(launches[0].expected.size, liveSignature(paths).bytes);

  // The helper failed: the same build boots again, only the archive mtime moved.
  // The signature must not change, or the guard would hand out a fresh budget.
  fs.utimesSync(paths.asar, new Date(), new Date(Date.now() + 5000));
  const second = ensureInstalled(paths, log, { launch });
  assert.equal(second.status, 'restarting');
  assert.equal(second.signature, first.signature);
  assert.equal(second.attempts, 2);

  const third = ensureInstalled(paths, log, { launch });
  assert.equal(third.status, 'auto_restart_exhausted');
  assert.equal(launches.length, 2);
  assert.equal(statusPayload(paths).autoRestart.guard.attempts, 2);
});

test('ensureInstalled does not self-heal while the guard is corrupt', () => {
  const paths = makePaths();
  writePristineAsar(paths.asar);
  fs.writeFileSync(paths.restartGuard, '{ broken json');
  const launches = [];
  const log = silentLog();

  const result = ensureInstalled(paths, log, { launch: (options) => launches.push(options) });
  assert.equal(result.status, 'auto_restart_guard_corrupt');
  assert.equal(launches.length, 0);
  assert.match(log.lines.join('\n'), /auto-restart disabled/);
});

test('ensureInstalled leaves an already patched live archive alone', () => {
  const paths = makePaths();
  writePatchedAsar(paths.asar);
  writePristineAsar(paths.backup);
  const launches = [];

  const result = ensureInstalled(paths, silentLog(), { launch: (options) => launches.push(options) });
  assert.equal(result.status, 'current');
  assert.equal(launches.length, 0);
  assert.equal(fs.existsSync(paths.restartGuard), false);
});

test('ensureInstalled rebuilds a half-patched archive from the pristine backup', () => {
  const paths = makePaths();
  // main already patched, account still pristine: readable, but not complete.
  writeAsar(paths.asar, bundleFiles({ main: patchMain(pristineMain()).text }));
  writePristineAsar(paths.backup);
  const launches = [];
  const log = silentLog();

  const result = ensureInstalled(paths, log, { launch: (options) => launches.push(options) });
  assert.equal(result.status, 'restarting');
  assert.equal(launches.length, 1);
  // The backup is the source here, so it must never be overwritten by the helper.
  assert.equal(launches[0].createBackup, false);
  assert.equal(launches[0].expected.size, liveSignature(paths).bytes);

  const meta = JSON.parse(fs.readFileSync(paths.stagedMeta, 'utf8'));
  assert.equal(meta.source, paths.backup);
  assert.equal(meta.expected, paths.asar);
  assert.equal(meta.sourceSize, fs.statSync(paths.backup).size);
  assert.equal(meta.expectedSize, liveSignature(paths).bytes);
  assert.notEqual(meta.sourceSize, meta.expectedSize);

  const stagedState = inspectPatchState(paths.stagedAsar);
  assert.equal(stagedState.mainPatched, true);
  assert.equal(stagedState.accountPatched, true);
  assert.ok(stagedState.accountSize > pristineAccount().length);
});

test('ensureInstalled honours the autoRestart opt-out', () => {
  const paths = makePaths();
  writePristineAsar(paths.asar);
  const launches = [];
  const result = ensureInstalled(paths, silentLog(), {
    autoRestart: false,
    launch: (options) => launches.push(options),
  });
  assert.equal(result.status, 'auto_restart_disabled');
  assert.equal(launches.length, 0);
});

test('ensureInstalled reports nothing_to_stage when the live archive is unreadable', () => {
  const paths = makePaths();
  fs.writeFileSync(paths.asar, 'not an asar');
  const result = ensureInstalled(paths, silentLog(), { launch: () => assert.fail('must not launch') });
  assert.equal(result.status, 'nothing_to_stage');
});