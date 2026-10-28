import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { buildPatchedAsar, inspectPatchState } from '../lib/patch.js';
import { desktopPaths } from '../lib/desktop.js';

const desktop = desktopPaths();
const defaultSource = desktop && fs.existsSync(desktop.backup) ? desktop.backup : desktop?.asar ?? 'D:\\Program Files (x86)\\dsh\\resources\\app.asar';
const source = process.argv[2] ?? defaultSource;
const outDir = process.argv[3] ?? (desktop ? desktop.staging : path.join(os.tmpdir(), 'dsh-retry-build'));
const outFile = path.join(outDir, 'app.asar.patched');
fs.mkdirSync(outDir, { recursive: true });

const started = Date.now();
console.log('source:', source);
console.log('state before:', inspectPatchState(source));
const result = buildPatchedAsar(source, outFile);
if (result.changed === false || result.patchedAsar == null) {
  console.error('source is already patched; pass a pristine app.asar (for example the .dsh-retry.bak backup)');
  process.exit(1);
}
console.log('changed:', result.changed, '->', result.patchedAsar);
console.log('state after:', inspectPatchState(result.patchedAsar));
console.log('size:', fs.statSync(result.patchedAsar).size, 'elapsed:', Date.now() - started, 'ms');
