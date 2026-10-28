import { readAsar, closeAsar, listFiles, readEntry } from '../lib/asar.js';
import { patchMain, patchAccount, MAIN_ENTRY, ACCOUNT_ENTRY } from '../lib/patch.js';

const asar = process.argv[2] ?? 'D:\\Program Files (x86)\\dsh\\resources\\app.asar';
const archive = readAsar(asar);
try {
  const byPath = new Map(listFiles(archive.tree).map((e) => [e.path, e]));
  for (const entryPath of [MAIN_ENTRY, ACCOUNT_ENTRY]) {
    const entry = byPath.get(entryPath);
    const text = readEntry(archive, entry).toString('utf8');
    const patcher = entryPath === MAIN_ENTRY ? patchMain : patchAccount;
    const result = patcher(text);
    console.log(entryPath, 'changed=', result.changed, 'size', entry.size, '->', Buffer.byteLength(result.text));
    const second = patcher(result.text);
    console.log('  idempotent=', second.changed === false);
  }
} finally {
  closeAsar(archive);
}
