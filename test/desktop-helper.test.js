import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { desktopPaths, powershellPath } from '../lib/desktop.js';
import { helperArgs, helperScript } from '../lib/helper.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const makeDesktop = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-retry-desktop-'));
  const exe = path.join(root, 'DeepSeek Harness.exe');
  fs.writeFileSync(exe, '');
  fs.mkdirSync(path.join(root, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(root, 'resources', 'app.asar'), '');
  return { root, exe };
};

test('desktopPaths is null outside the desktop runtime', () => {
  assert.equal(desktopPaths({ electron: undefined }), null);
  assert.equal(desktopPaths({ electron: '33.0.0', execPath: 'C:\\node.exe' }), null);
});

test('desktopPaths resolves the resources layout on the archive volume', () => {
  const { exe, root } = makeDesktop();
  const paths = desktopPaths({ electron: '33.0.0', execPath: exe });
  const resources = path.join(root, 'resources');
  assert.equal(paths.exe, exe);
  assert.equal(paths.asar, path.join(resources, 'app.asar'));
  assert.equal(paths.trigger, path.join(resources, 'dsh-retry.restart'));
  assert.equal(paths.backup, path.join(resources, 'app.asar.dsh-retry.bak'));
  // Staging must live next to the archive so the swap stays on one volume.
  assert.equal(paths.staging, path.join(resources, 'dsh-retry-build'));
  assert.equal(paths.stagedAsar, path.join(resources, 'dsh-retry-build', 'app.asar.patched'));
  assert.equal(paths.restartGuard, path.join(resources, 'dsh-retry-build', 'restart-guard.json'));
});

test('powershellPath is absolute and path-independent', () => {
  const result = powershellPath({ SystemRoot: 'C:\\Windows' });
  assert.equal(result, path.win32.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
});

test('helperArgs passes the expected switches', () => {
  const paths = {
    asar: 'A',
    backup: 'B',
    exe: 'C',
    helperLog: 'L',
  };
  const base = { script: 'S.ps1', mainPid: 42, paths, staged: 'P.asar' };
  const normal = helperArgs(base);
  assert.equal(normal[normal.indexOf('-MainPid') + 1], '42');
  assert.equal(normal[normal.indexOf('-PatchedAsar') + 1], 'P.asar');
  assert.equal(normal[normal.indexOf('-LogPath') + 1], 'L');

  const withExpected = helperArgs({ ...base, expected: { size: 100, mtimeMs: 1234.9 } });
  assert.equal(withExpected[withExpected.indexOf('-ExpectedAsarSize') + 1], '100');
  assert.equal(withExpected[withExpected.indexOf('-ExpectedAsarMtimeMs') + 1], '1234');
});

test('helperScript lives in the package scripts directory', () => {
  assert.equal(helperScript('/pkg'), path.join('/pkg', 'scripts', 'restart-helper.ps1'));
});

test('helperArgs forwards the backup-creation switch only when asked', () => {
  const paths = { asar: 'A', backup: 'B', exe: 'C', helperLog: 'L' };
  const base = { script: 'S.ps1', mainPid: 42, paths, staged: 'P.asar' };
  assert.equal(helperArgs(base).includes('-CreateBackup'), false);
  assert.equal(helperArgs({ ...base, createBackup: true }).includes('-CreateBackup'), true);
});

test('helper script only creates a backup on request and survives a failed swap', () => {
  const script = fs.readFileSync(helperScript(ROOT), 'utf8');
  // A patched live archive must never become the pristine backup: the Node side
  // passes -CreateBackup only after it verified the archive is unpatched.
  assert.ok(script.includes('if ($CreateBackup -and -not (Test-Path -LiteralPath $BackupPath))'));
  // The freshness check has to run before the app is stopped, otherwise a stale
  // request costs the user a restart for nothing.
  assert.ok(script.indexOf('leaving the app alone') < script.indexOf('stopping main process'));
  // Any failure after the stop has to bring DSH back.
  assert.ok(script.includes('$script:appStopped = $true'));
  assert.ok(script.includes('if ($script:appStopped) {'));
  // Helpers killed mid-copy leave ~180 MB temp files; they must be swept up.
  assert.ok(script.includes("'.dsh-retry.*.tmp'"));
  assert.ok(script.includes('Remove-StaleTemp'));
  // ... and a swap failure path must remove the helper's own temp copy.
  assert.ok(script.includes('finally {'));
  assert.ok(script.includes("$tmp = $AsarPath + '.dsh-retry.' + $PID + '.tmp'"));
});
