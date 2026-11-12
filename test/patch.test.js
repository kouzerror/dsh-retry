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
  assert.deepEqual(first.applied, ['enLabel', 'zhLabel', 'trayItem', 'appMenuItem', 'watcher']);
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

test('patchMain adds the application menu restart item above quit', { skip: !available && 'no pristine app.asar' }, () => {
  const patched = patchMain(mainText).text;
  assert.equal(patched.includes('/* appMenuRestart */'), true);
  // 只插入一次，重复运行不会出现第二项
  assert.equal(patched.match(/appMenuRestart/g).length, 1);
  // 位置：hideCommands 之后、quit 之前
  const hide = patched.indexOf('...hideCommands');
  const restart = patched.indexOf('appMenuRestart');
  const quit = patched.indexOf('role: "quit"');
  assert.ok(hide > -1 && restart > hide && quit > restart);
});

test('patchMain completes a bundle missing only the application menu item', { skip: !available && 'no pristine app.asar' }, () => {
  const patched = patchMain(mainText).text;
  const withoutAppMenu = patched.replace(
    '\t\t/* appMenuRestart */\n' +
      '\t\t{\n' +
      '\t\t\tlabel: currentDesktopLocale().messages.restartApplication,\n' +
      '\t\t\tclick: () => {\n' +
      '\t\t\t\tif (quitting) return;\n' +
      '\t\t\t\tapp.relaunch();\n' +
      '\t\t\t\tquitWithoutConfirmation();\n' +
      '\t\t\t}\n' +
      '\t\t},\n',
    ''
  );
  assert.notEqual(withoutAppMenu, patched);
  const result = patchMain(withoutAppMenu);
  assert.equal(result.changed, true);
  assert.deepEqual(result.applied, ['appMenuItem']);
  assert.equal(result.text, patched);
});

test('unknown bundle shapes fail loudly instead of writing a partial patch', () => {
  assert.throws(() => patchMain('nothing to patch here'), /patch anchor not found/);
  assert.throws(() => patchAccount('nothing to patch here'), /patch anchor not found/);
});
