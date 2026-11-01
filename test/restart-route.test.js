import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRestartHandler } from '../lib/index.js';
import { MAIN_ENTRY } from '../lib/patch.js';
import { createLogger, readTail } from '../lib/log.js';
import { writeAsar } from './fixtures/write-asar.mjs';
import { pristineMain, writePatchedAsar, writePristineAsar } from './fixtures/pristine-bundle.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-retry-route-'));

function makePaths() {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  const resources = path.join(dir, 'resources');
  const staging = path.join(resources, 'dsh-retry-build');
  fs.mkdirSync(staging, { recursive: true });
  return {
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

function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    headersSent: false,
    onEnd: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(body) {
      if (this.headersSent) throw new Error('response already ended');
      this.headersSent = true;
      this.raw = body;
      this.body = body === undefined ? undefined : JSON.parse(body);
      this.onEnd?.();
    },
  };
}

function request(overrides = {}) {
  return { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' }, ...overrides };
}

const quietLogger = () => Object.assign(() => {}, { file: null });

test('restart route rejects non-POST requests', async () => {
  const { handler } = createRestartHandler({ launch: () => {}, logger: quietLogger });
  const res = fakeResponse();
  await handler({ method: 'GET', headers: {} }, res, makePaths());
  assert.equal(res.statusCode, 405);
  assert.deepEqual(res.body, { ok: false, error: 'method_not_allowed' });
});

test('restart route rejects cross-origin requests', async () => {
  const { handler } = createRestartHandler({ launch: () => {}, logger: quietLogger });
  const res = fakeResponse();
  await handler(request({ headers: { 'sec-fetch-site': 'cross-site' } }), res, makePaths());
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { ok: false, error: 'cross_origin_request' });
});

test('restart route reports unwritable resources with 503', async () => {
  const paths = makePaths();
  paths.asar = path.join(paths.resources, 'missing', 'app.asar');
  const { handler, restarting } = createRestartHandler({ launch: () => {}, logger: quietLogger });
  const res = fakeResponse();
  await handler(request(), res, paths);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { ok: false, error: 'resources_not_writable' });
  // The request never reached a helper, so a later click must not be blocked.
  assert.equal(restarting.value, false);
});

test('restart route stages a patch, launches the helper and latches', async () => {
  const paths = makePaths();
  writePristineAsar(paths.asar, { version: '0.3.0' });
  const launches = [];
  const { handler, restarting } = createRestartHandler({
    launch: (options) => launches.push(options),
    logger: quietLogger,
  });

  const res = fakeResponse();
  await handler(request(), res, paths);
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.mode, 'patch-and-restart');
  assert.equal(res.body.staged, paths.stagedAsar);
  assert.equal(launches.length, 1);
  assert.equal(launches[0].staged, paths.stagedAsar);
  assert.equal(launches[0].createBackup, true);
  assert.equal(launches[0].expected.size, fs.statSync(paths.asar).size);
  assert.equal(restarting.value, true);

  // A second click while the helper works must not start a second helper.
  const second = fakeResponse();
  await handler(request(), second, paths);
  assert.equal(second.statusCode, 409);
  assert.deepEqual(second.body, { ok: false, error: 'restart_in_progress' });
  assert.equal(launches.length, 1);
});

test('restart route answers before writing the trigger file', async () => {
  const paths = makePaths();
  writePatchedAsar(paths.asar);
  const { handler } = createRestartHandler({
    launch: () => assert.fail('an up-to-date patch must not launch a helper'),
    logger: quietLogger,
  });

  const res = fakeResponse();
  res.onEnd = () => {
    res.triggerAtEnd = fs.existsSync(paths.trigger);
  };
  await handler(request(), res, paths);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, mode: 'restart' });
  // The patched app relaunches right after the trigger appears; the response must
  // already be on the wire by then or the click surfaces as a network error.
  assert.equal(res.triggerAtEnd, false);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fs.existsSync(paths.trigger), true);
});

test('restart route releases the latch when the trigger cannot be written', async () => {
  const paths = makePaths();
  writePatchedAsar(paths.asar);
  paths.trigger = path.join(paths.resources, 'missing', 'dsh-retry.restart');
  const { handler, restarting } = createRestartHandler({ launch: () => {}, logger: createLogger });

  const res = fakeResponse();
  await handler(request(), res, paths);
  assert.equal(res.statusCode, 200);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(restarting.value, false);
  assert.match(readTail(paths.buildLog, 10).join('\n'), /post-response action failed/);
});

test('restart route reports a failed stage with 500 and keeps the latch free', async () => {
  const paths = makePaths();
  // Readable archive, but the account bundle is missing so the build must throw.
  writeAsar(
    paths.asar,
    new Map([
      ['package.json', JSON.stringify({ name: 'deepseek-harness-desktop', version: '0.3.0' })],
      [MAIN_ENTRY, pristineMain()],
    ]),
  );
  const { handler, restarting } = createRestartHandler({ launch: () => {}, logger: createLogger });

  const res = fakeResponse();
  await handler(request(), res, paths);
  assert.equal(res.statusCode, 500);
  assert.match(res.body.error, /missing/);
  assert.equal(restarting.value, false);
  // The stack is logged as one multi-line entry; a swallowed error was the old bug.
  assert.match(fs.readFileSync(paths.buildLog, 'utf8'), /restart failed: /);
  assert.match(fs.readFileSync(paths.buildLog, 'utf8'), /buildPatchedAsar/);

  // The failure is transient from the user's point of view: retrying is allowed.
  const retry = fakeResponse();
  await handler(request(), retry, paths);
  assert.equal(retry.statusCode, 500);
});

test('restart route reports nothing_to_install when no source is available', async () => {
  const paths = makePaths();
  fs.writeFileSync(paths.asar, 'not an asar');
  const { handler } = createRestartHandler({ launch: () => {}, logger: createLogger });

  const res = fakeResponse();
  await handler(request(), res, paths);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { ok: false, error: 'nothing_to_install' });
  assert.match(readTail(paths.buildLog, 10).join('\n'), /no patch could be staged/);
});