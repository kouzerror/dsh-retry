import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readTail, createLogger } from '../lib/log.js';
import { autoRestartBudget, statusPayload } from '../lib/index.js';
import { writeAsar } from './fixtures/write-asar.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-retry-status-'));

function fakePaths() {
  return {
    asar: path.join(tmp, 'app.asar'),
    backup: path.join(tmp, 'app.asar.bak'),
    stagedAsar: path.join(tmp, 'app.asar.patched'),
    stagedMeta: path.join(tmp, 'app.asar.patched.meta.json'),
    helperLog: path.join(tmp, 'helper.log'),
    buildLog: path.join(tmp, 'build.log'),
    staging: tmp,
    restartGuard: path.join(tmp, 'restart-guard.json'),
    trigger: path.join(tmp, 'trigger'),
    exe: path.join(tmp, 'DeepSeek Harness.exe'),
  };
}

test('createLogger returns a callable logger', () => {
  const file = path.join(tmp, 'callable.log');
  const log = createLogger(file);
  assert.equal(typeof log, 'function');
  log('callable message');
  log.write('property message');
  const lines = readTail(file, 2);
  assert.match(lines[0], /callable message$/);
  assert.match(lines[1], /property message$/);
});

test('statusPayload reports an unpatched archive without throwing', () => {
  const paths = fakePaths();
  writeAsar(paths.asar, new Map([['index.html', '<html></html>']]));
  const payload = statusPayload(paths);
  assert.equal(payload.ok, true);
  assert.equal(payload.desktop, true);
  assert.equal(payload.patched, false);
  assert.equal(payload.mainPatched, false);
  assert.equal(payload.accountPatched, false);
  assert.equal(payload.staged, null);
  assert.equal(payload.backup.exists, false);
  assert.equal(typeof payload.writeAccess, 'boolean');
  assert.equal(payload.autoRestart.limit, 2);
  assert.equal(payload.autoRestart.guard, null);
});

test('statusPayload surfaces a staged archive and its meta', () => {
  const paths = fakePaths();
  writeAsar(paths.asar, new Map([['index.html', '<html></html>']]));
  fs.writeFileSync(paths.stagedAsar, 'staged');
  fs.writeFileSync(paths.stagedMeta, JSON.stringify({ desktopVersion: '0.2.1-rc.3', builtAt: 'x', size: 1, mtimeMs: 2 }));
  const payload = statusPayload(paths);
  assert.equal(payload.staged.bytes, 6);
  assert.match(payload.staged.path, /app\.asar\.patched$/);
  assert.equal(payload.staged.meta.desktopVersion, '0.2.1-rc.3');
});

test('autoRestartBudget only spends attempts on the same archive signature', () => {
  const paths = fakePaths();
  writeAsar(paths.asar, new Map([['index.html', '<html></html>']]));
  assert.deepEqual(autoRestartBudget(paths, 'sig-a'), { signature: 'sig-a', attempts: 0, exhausted: false });

  fs.writeFileSync(paths.restartGuard, JSON.stringify({ signature: 'sig-a', attempts: 2 }));
  assert.equal(autoRestartBudget(paths, 'sig-a').exhausted, true);
  // A new DSH build has a new signature, so it gets its own budget.
  assert.equal(autoRestartBudget(paths, 'sig-b').exhausted, false);
  assert.equal(statusPayload(paths).autoRestart.guard.signature, 'sig-a');
});

test('readTail returns the newest log lines and tolerates missing files', () => {
  const file = path.join(tmp, 'tail.log');
  const logger = createLogger(file);
  for (const line of ['one', 'two', 'three']) logger(line);
  assert.deepEqual(readTail(file, 2).map((line) => line.slice(line.indexOf('] ') + 2)), ['two', 'three']);
  assert.deepEqual(readTail(path.join(tmp, 'nope.log')), []);
});
