import fs from 'node:fs';
const A = 'D:\\Program Files (x86)\\dsh\\resources\\app.asar';
const B = process.argv[2];
const fa = fs.openSync(A, 'r'), fb = fs.openSync(B, 'r');
const sa = fs.fstatSync(fa).size, sb = fs.fstatSync(fb).size;
console.log('sizes', sa, sb);
const CH = 1 << 20;
let off = 0, shown = 0, totalDiffs = 0;
while (off < Math.min(sa, sb)) {
  const n = Math.min(CH, Math.min(sa, sb) - off);
  const ba = Buffer.alloc(n), bb = Buffer.alloc(n);
  fs.readSync(fa, ba, 0, n, off); fs.readSync(fb, bb, 0, n, off);
  for (let i = 0; i < n; i++) {
    if (ba[i] !== bb[i]) {
      totalDiffs++;
      if (shown < 10) {
        console.log('diff at file offset', off + i, 'orig', ba[i], 'built', bb[i], 'ctx A', JSON.stringify(ba.subarray(Math.max(0, i - 24), i + 8).toString('latin1')), 'ctx B', JSON.stringify(bb.subarray(Math.max(0, i - 24), i + 8).toString('latin1')));
        shown++;
      }
    }
  }
  off += n;
}
console.log('total differing bytes', totalDiffs);
