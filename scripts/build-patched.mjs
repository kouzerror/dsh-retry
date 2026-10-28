import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { buildPatchedAsar, inspectPatchState } from '../lib/patch.js';

const source = process.argv[2] ?? 'D:\\Program Files (x86)\\dsh\\resources\\app.asar';
const outDir = process.argv[3] ?? path.join(os.tmpdir(), 'dsh-retry-build');
const outFile = path.join(outDir, 'app.asar.patched');
fs.mkdirSync(outDir, { recursive: true });

const started = Date.now();
console.log('source:', source);
console.log('state before:', inspectPatchState(source));
const result = buildPatchedAsar(source, outFile);
console.log('changed:', result.changed, '->', result.patchedAsar);
console.log('state after:', inspectPatchState(result.patchedAsar));
console.log('size:', fs.statSync(result.patchedAsar).size, 'elapsed:', Date.now() - started, 'ms');
