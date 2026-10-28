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

test('desktopPaths resolves the resources layout', () => {
  const { exe, root } = makeDesktop();
  const paths = desktopPaths({ electron: '33.0.0', execPath: exe, tmpdir: root });
  assert.equal(paths.exe, exe);
  assert.equal(paths.asar, path.join(root, 'resources', 'app.asar'));
  assert.equal(paths.trigger, path.join(root, 'resources', 'dsh-retry.restart'));
  assert.equal(paths.backup, path.join(root, 'resources', 'app.asar.dsh-retry.bak'));
  assert.equal(paths.stagedAsar, path.join(root, 'dsh-retry-build', 'app.asar.patched'));
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
  };
  const base = { script: 'S.ps1', mainPid: 42, paths, staged: 'P.asar' };
  const normal = helperArgs(base);
  assert.equal(normal.includes('-InstallOnly'), false);
  assert.equal(normal[normal.indexOf('-MainPid') + 1], '42');
  assert.equal(normal[normal.indexOf('-PatchedAsar') + 1], 'P.asar');
  assert.equal(normal[normal.indexOf('-LogPath') + 1], 'L');

  const installOnly = helperArgs({ ...base, installOnly: true });
  assert.equal(installOnly.at(-1), '-InstallOnly');
});

test('helperScript lives in the package scripts directory', () => {
  assert.equal(helperScript('/pkg'), path.join('/pkg', 'scripts', 'restart-helper.ps1'));
});
