import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { extractEntry } from '../lib/asar.js';
import { ACCOUNT_ENTRY, MAIN_ENTRY, patchAccount, patchMain } from '../lib/patch.js';
import { legacyAccount, pristineAccount } from './fixtures/pristine-bundle.mjs';

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
  assert.deepEqual(first.applied, ['item', 'handler', 'labels']);
  assert.equal(first.missing.length, 0);
  assert.equal(patchAccount(first.text).changed, false);
});

/** Cut the injected restart item back out, to check the incremental path. */
function withoutRestartItem(text) {
  const match = /,\{id:\s*["'`]dsh-retry-restart["'`]/.exec(text);
  assert.ok(match, 'expected the injected restart item to be present');
  let depth = 0;
  for (let index = match.index + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' || char === "'" || char === '`') {
      for (index += 1; index < text.length && text[index] !== char; index += 1) {
        if (text[index] === '\\') index += 1;
      }
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(0, match.index) + text.slice(index + 1);
    }
  }
  throw new Error('the injected restart item is not balanced');
}

test('patchAccount restores a missing menu item only', { skip: !available && 'no pristine app.asar' }, () => {
  const patched = patchAccount(accountText).text;
  const result = patchAccount(withoutRestartItem(patched));
  assert.equal(result.changed, true);
  assert.deepEqual(result.applied, ['item']);
  assert.equal(result.text, patched);
});

test('unknown bundle shapes fail loudly instead of writing a partial patch', () => {
  assert.throws(() => patchMain('nothing to patch here'), /patch anchor not found/);
  assert.throws(() => patchAccount('nothing to patch here'), /patch anchor not found/);
});

// The fixture mirrors the minified build, so these run on machines without a
// real app.asar (CI) and still cover both quote styles plus locale selection.
test('patchAccount handles the minified build', () => {
  const result = patchAccount(pristineAccount());
  assert.deepEqual(result.applied, ['item', 'handler', 'labels']);
  assert.deepEqual(result.missing, []);
  assert.match(result.text, /dsh-retry-restart`,\s*label:t\(`dshRetryRestart`\)/);
  assert.match(result.text, /else if\(id===`dsh-retry-restart`\)\{setOpen\(false\);fetch\(location\.origin \+ '\/dsh-retry\/restart'/);
  assert.match(result.text, /contactUs:`Feedback`,dshRetryRestart:`Restart DeepSeek Harness`,/);
  assert.match(result.text, /contactUs:`意见反馈`,dshRetryRestart:`重启 DeepSeek Harness`,/);
  assert.match(result.text, /contactUs:`Rückmeldung`,dshRetryRestart:`DeepSeek Harness neu starten`,/);
  assert.match(result.text, /contactUs:`Обратная связь`,dshRetryRestart:`Перезапустить DeepSeek Harness`,/);
});

test('patchAccount still handles the pretty-printed bundle older releases shipped', () => {
  const result = patchAccount(legacyAccount());
  assert.deepEqual(result.applied, ['item', 'handler', 'labels']);
  assert.deepEqual(result.missing, []);
  assert.match(result.text, /id: "dsh-retry-restart"/);
  assert.match(result.text, /contactUs: "Feedback",\n\t\t\tdshRetryRestart: "Restart DeepSeek Harness",/);
  assert.match(result.text, /\} else if\(id==="dsh-retry-restart"\)\{setOpen\(false\);fetch\(/);
});
