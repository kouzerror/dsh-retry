import { readAsar, listFiles, readEntry, closeAsar } from '../lib/asar.js';

const asar = process.argv[2];
const needle = process.argv[3] ?? 'IconSettingsOutlineMedium';
const archive = readAsar(asar);
const hits = [];
for (const entry of listFiles(archive.tree)) {
  if (entry.size === 0 || entry.size > 30 * 1024 * 1024) continue;
  const buf = readEntry(archive, entry);
  if (buf.includes(needle)) hits.push({ path: entry.path, size: entry.size, count: buf.toString('latin1').split(needle).length - 1 });
}
closeAsar(archive);
hits.sort((a, b) => b.count - a.count);
console.log(JSON.stringify(hits.slice(0, 20), null, 2));
