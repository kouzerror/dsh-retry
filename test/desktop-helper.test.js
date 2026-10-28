import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { desktopPaths, powershellPath } from '../lib/desktop.js';
import { helperArgs, helperScript } from '../lib/helper.js';

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
  assert.equal(paths.marker, path.join(resources, 'dsh-retry-build', 'install-armed.json'));
});

test('powershellPath is absolute and path-independent', () => {
  const result = powershellPath({ SystemRoot: 'C:\\Windows' });
  assert.equal(result, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
});

test('helperArgs passes the expected switches', () => {
  const paths = {
    asar: 'A',
    backup: 'B',
    exe: 'C',
    helperLog: 'L',
    marker: 'M',
  };
  const base = { script: 'S.ps1', mainPid: 42, paths, staged: 'P.asar' };
  const normal = helperArgs(base);
  assert.equal(normal.includes('-InstallOnly'), false);
  assert.equal(normal[normal.indexOf('-MainPid') + 1], '42');
  assert.equal(normal[normal.indexOf('-PatchedAsar') + 1], 'P.asar');
  assert.equal(normal[normal.indexOf('-LogPath') + 1], 'L');
  assert.equal(normal[normal.indexOf('-MarkerPath') + 1], 'M');

  const withExpected = helperArgs({ ...base, expected: { size: 100, mtimeMs: 1234.9 } });
  assert.equal(withExpected[withExpected.indexOf('-ExpectedAsarSize') + 1], '100');
  assert.equal(withExpected[withExpected.indexOf('-ExpectedAsarMtimeMs') + 1], '1234');

  const installOnly = helperArgs({ ...base, installOnly: true });
  assert.equal(installOnly.at(-1), '-InstallOnly');
});

test('helperScript lives in the package scripts directory', () => {
  assert.equal(helperScript('/pkg'), path.join('/pkg', 'scripts', 'restart-helper.ps1'));
});
