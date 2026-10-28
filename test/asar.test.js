import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  closeAsar,
  extractEntry,
  findEntry,
  listFiles,
  readAsar,
  readEntry,
  rebuildAsar,
  summarize,
  verifyAsar,
} from '../lib/asar.js';
import { writeAsar } from './fixtures/write-asar.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-retry-asar-'));

function fixture() {
  return {
    'a.txt': 'alpha\n',
    'dir/empty.txt': '',
    'dir/big.bin': crypto.randomBytes(9000),
  };
}

test('reads entries and reports layout', () => {
  const file = path.join(tmp, 'base.asar');
  writeAsar(file, new Map(Object.entries(fixture())));
  const archive = readAsar(file);
  try {
    const stored = listFiles(archive.tree);
    assert.deepEqual(stored.map((entry) => entry.path), ['a.txt', 'dir/big.bin', 'dir/empty.txt']);
    assert.equal(stored[0].offset, 0);
    assert.equal(readEntry(archive, stored[0]).toString(), 'alpha\n');
    assert.equal(readEntry(archive, stored[2]).length, 0);
    assert.deepEqual(summarize(archive.tree), { files: 3, stored: 3, unpacked: 0, storedBytes: 6 + 9000 });
  } finally {
    closeAsar(archive);
  }
});

test('verify accepts a well-formed archive and rejects tampering', () => {
  const file = path.join(tmp, 'verify.asar');
  writeAsar(file, new Map(Object.entries(fixture())));
  assert.deepEqual(verifyAsar(file, { deep: true }).ok, true);

  const bytes = fs.readFileSync(file);
  bytes[bytes.length - 200] = 0xff;
  const tampered = path.join(tmp, 'tampered.asar');
  fs.writeFileSync(tampered, bytes);
  const result = verifyAsar(tampered, { deep: true });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes('integrity mismatch')));
});

test('rebuild replaces one entry and keeps the rest byte-identical', () => {
  const source = path.join(tmp, 'source.asar');
  writeAsar(source, new Map(Object.entries(fixture())));
  const out = path.join(tmp, 'out.asar');
  const replacement = Buffer.from('patched!\n');
  rebuildAsar(source, out, new Map([['a.txt', replacement]]));

  assert.equal(verifyAsar(out, { deep: true }).ok, true);
  assert.equal(extractEntry(out, 'a.txt').toString(), 'patched!\n');
  assert.equal(extractEntry(out, 'dir/empty.txt').length, 0);
  assert.equal(findEntry(readAsar(out).tree, 'dir/big.bin').size, 9000);
});

test('readAsar rejects files that are not asar archives', () => {
  const file = path.join(tmp, 'junk.bin');
  fs.writeFileSync(file, Buffer.alloc(64, 7));
  assert.throws(() => readAsar(file), /invalid asar lead/);
});
