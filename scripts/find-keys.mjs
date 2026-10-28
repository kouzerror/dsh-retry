import { readAsar, closeAsar, listFiles, readEntry } from '../lib/asar.js';

const archive = readAsar(process.argv[2]);
try {
  const entry = listFiles(archive.tree).find((e) => e.path === 'lib/main.js');
  const text = readEntry(archive, entry).toString('utf8');
  for (const needle of ['restartApplication', 'restartAppHostMenu', 'openApplication', 'quitApplication']) {
    console.log('===', needle);
    let from = 0, count = 0;
    while (true) {
      const i = text.indexOf(needle, from);
      if (i < 0) break;
      count++;
      console.log(`  [${count}] @${i}:`, JSON.stringify(text.slice(Math.max(0, i - 90), i + 120)));
      from = i + needle.length;
    }
    console.log('  total', count);
  }
} finally {
  closeAsar(archive);
}
