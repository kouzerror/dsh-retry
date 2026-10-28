import fs from 'node:fs';
import { rebuildAsar, verifyAsar, sha256 } from '../lib/asar.js';

const src = process.argv[2];
const out = process.argv[3];
const t0 = Date.now();
const result = rebuildAsar(src, out);
console.log('built', JSON.stringify(result), 'in', Date.now() - t0, 'ms');
const a = sha256(fs.readFileSync(src));
const b = sha256(fs.readFileSync(out));
console.log('identical:', a === b);
console.log('source', a);
console.log('built ', b);
console.log('verify', JSON.stringify(verifyAsar(out)));
