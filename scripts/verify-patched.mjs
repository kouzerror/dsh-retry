import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readAsar, closeAsar, listFiles, readEntry, verifyAsar } from '../lib/asar.js';
import { MAIN_ENTRY, ACCOUNT_ENTRY } from '../lib/patch.js';

const source = process.argv[2] ?? 'D:\\Program Files (x86)\\dsh\\resources\\app.asar';
const patched = process.argv[3] ?? path.join(os.tmpdir(), 'dsh-retry-build', 'app.asar.patched');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const sourceArchive = readAsar(source);
const patchedArchive = readAsar(patched);
try {
  const sourceEntries = new Map(listFiles(sourceArchive.tree).map((e) => [e.path, e]));
  const patchedEntries = new Map(listFiles(patchedArchive.tree).map((e) => [e.path, e]));
  console.log('entries:', sourceEntries.size, '->', patchedEntries.size);

  const missing = [...sourceEntries.keys()].filter((p) => !patchedEntries.has(p));
  const added = [...patchedEntries.keys()].filter((p) => !sourceEntries.has(p));
  console.log('missing:', missing.length, 'added:', added.length);

  let identical = 0;
  const differing = [];
  for (const [p, entry] of sourceEntries) {
    const other = patchedEntries.get(p);
    if (!other) continue;
    if (entry.size === other.size && entry.offset !== undefined) {
      const a = readEntry(sourceArchive, entry);
      const b = readEntry(patchedArchive, other);
      if (a.equals(b)) identical++;
      else differing.push(p);
    }
  }
  console.log('byte-identical stored files:', identical, 'differing:', differing);
  console.log('unpacked entries untouched:', [...patchedEntries.values()].filter((e) => e.offset === undefined).length);

  verifyAsar(patched, { deep: true });
  console.log('deep verify: OK');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-retry-check-'));
  for (const [entryPath, name] of [[MAIN_ENTRY, 'main.mjs'], [ACCOUNT_ENTRY, 'account.js']]) {
    const text = readEntry(patchedArchive, patchedEntries.get(entryPath)).toString('utf8');
    const file = path.join(tmp, name);
    fs.writeFileSync(file, text);
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log(`${entryPath}: syntax OK, sha256=${sha(Buffer.from(text))}`);
    if (entryPath === MAIN_ENTRY) {
      console.log('  marker:', text.includes('dsh-retry.restart'));
      const view = text.slice(text.indexOf('setContextMenu'), text.indexOf('setContextMenu') + 900);
      console.log('  tray menu snippet:', JSON.stringify(view));
    }
  }
  console.log('check dir:', tmp);
} finally {
  closeAsar(sourceArchive);
  closeAsar(patchedArchive);
}
