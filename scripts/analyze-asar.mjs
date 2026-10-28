import fs from 'node:fs';
import crypto from 'node:crypto';

const asar = process.argv[2];
const fd = fs.openSync(asar, 'r');
const fileSize = fs.fstatSync(fd).size;
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(4);
const pickleBuf = Buffer.alloc(headerSize);
fs.readSync(fd, pickleBuf, 0, headerSize, 8);
const jsonLen = pickleBuf.readUInt32LE(4);
const json = pickleBuf.subarray(8, 8 + jsonLen).toString('utf8');
const tree = JSON.parse(json);
const dataStart = 8 + headerSize;

function walk(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files)) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (entry.files) walk(entry, p, out);
    else out.push({ path: p, ...entry });
  }
  return out;
}
const entries = walk(tree, '', []);
console.log('files', entries.length, 'dataStart', dataStart, 'fileSize', fileSize);
const unpacked = entries.filter(e => e.unpacked);
console.log('unpacked', unpacked.length);
const withSize = entries
  .filter(e => e.offset !== undefined && e.size > 0 && !e.unpacked)
  .map(e => ({ ...e, offset: Number(e.offset) }));
const sorted = withSize.slice().sort((a, b) => a.offset - b.offset);
let cursor = 0, gaps = 0, misaligned = 0, mismatch = 0;
for (const e of sorted) {
  if (e.offset % 4) misaligned++;
  if (e.offset !== cursor) {
    if (e.offset > cursor) gaps++;
    else mismatch++;
  }
  cursor = e.offset + e.size;
}
console.log('first offset', sorted[0].offset, 'last end', cursor, 'dataEnd', fileSize - dataStart);
console.log('gaps', gaps, 'overlaps', mismatch, 'unaligned', misaligned);

// verify integrity for a sample
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
for (const p of ['lib/main.js', 'package.json']) {
  const e = withSize.find(x => x.path === p);
  const buf = Buffer.alloc(e.size);
  fs.readSync(fd, buf, 0, e.size, dataStart + e.offset);
  const h = sha256(buf);
  console.log(p, 'size', e.size, 'hash match', h === e.integrity?.hash, 'blocks', e.integrity?.blocks?.length);
}
// sample alignment of offsets distribution
const buckets = new Map();
for (const e of sorted) buckets.set(e.offset % 8, (buckets.get(e.offset % 8) || 0) + 1);
console.log('offset mod 8', [...buckets]);
fs.closeSync(fd);
