import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readTail, createLogger } from '../lib/log.js';
import { statusPayload } from '../lib/index.js';
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
    marker: path.join(tmp, 'install-armed.json'),
    trigger: path.join(tmp, 'trigger'),
    exe: path.join(tmp, 'DeepSeek Harness.exe'),
  };
}

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
});

test('statusPayload surfaces a staged archive', () => {
  const paths = fakePaths();
  writeAsar(paths.asar, new Map([['index.html', '<html></html>']]));
  fs.writeFileSync(paths.stagedAsar, 'staged');
  const payload = statusPayload(paths);
  assert.equal(payload.staged.bytes, 6);
  assert.match(payload.staged.path, /app\.asar\.patched$/);
});

test('readTail returns the newest log lines and tolerates missing files', () => {
  const file = path.join(tmp, 'tail.log');
  const logger = createLogger(file);
  for (const line of ['one', 'two', 'three']) logger.write(line);
  assert.deepEqual(readTail(file, 2).map((line) => line.slice(line.indexOf('] ') + 2)), ['two', 'three']);
  assert.deepEqual(readTail(path.join(tmp, 'nope.log')), []);
});
