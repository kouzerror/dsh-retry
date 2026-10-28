import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { extractEntry } from '../lib/asar.js';
import { ACCOUNT_ENTRY, MAIN_ENTRY, patchAccount, patchMain } from '../lib/patch.js';

// The pristine archive kept by the plugin after its first install. Tests that
// need the real bundle shapes are skipped on machines without it (CI).
const BACKUP = process.env.DSH_RETRY_BACKUP ?? 'D:\\Program Files (x86)\\dsh\\resources\\app.asar.dsh-retry.bak';
const available = fs.existsSync(BACKUP);
const mainText = available ? extractEntry(BACKUP, MAIN_ENTRY).toString('utf8') : '';
const accountText = available ? extractEntry(BACKUP, ACCOUNT_ENTRY).toString('utf8') : '';

test('patchMain patches a pristine bundle and is idempotent', { skip: !available && 'no pristine app.asar' }, () => {
  const first = patchMain(mainText);
  assert.equal(first.changed, true);
  assert.deepEqual(first.applied, ['enLabel', 'zhLabel', 'trayItem', 'watcher']);
  assert.equal(first.missing.length, 0);
  const second = patchMain(first.text);
  assert.equal(second.changed, false);
});

test('patchMain completes a half-patched bundle without duplicating entries', { skip: !available && 'no pristine app.asar' }, () => {
  const patched = patchMain(mainText).text;
  const half = patched.replace('restartApplication: "Restart DeepSeek Harness",', 'restartApplication: "Restart",');
  const result = patchMain(half);
  assert.equal(result.changed, true);
  assert.deepEqual(result.applied, ['enLabel']);
  assert.equal(result.text, patched);
});

test('patchAccount patches a pristine bundle and is idempotent', { skip: !available && 'no pristine app.asar' }, () => {
  const first = patchAccount(accountText);
  assert.equal(first.changed, true);
  assert.deepEqual(first.applied, ['item', 'handler', 'enLabel', 'zhLabel']);
  assert.equal(first.missing.length, 0);
  assert.equal(patchAccount(first.text).changed, false);
});

test('patchAccount restores a missing menu item only', { skip: !available && 'no pristine app.asar' }, () => {
  const patched = patchAccount(accountText).text;
  const itemStart = patched.indexOf('\t\t\t\t\t\t\t{\n\t\t\t\t\t\t\t\tid: "dsh-retry-restart"');
  const itemEnd = patched.indexOf('\t\t\t\t\t\t\t},', itemStart) + '\t\t\t\t\t\t\t},'.length;
  const half = patched.slice(0, itemStart) + patched.slice(itemEnd);
  const result = patchAccount(half);
  assert.equal(result.changed, true);
  assert.deepEqual(result.applied, ['item']);
});

test('unknown bundle shapes fail loudly instead of writing a partial patch', () => {
  assert.throws(() => patchMain('nothing to patch here'), /patch anchor not found/);
  assert.throws(() => patchAccount('nothing to patch here'), /patch anchor not found/);
});
