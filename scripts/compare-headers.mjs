import fs from 'node:fs';
const A = 'D:\\Program Files (x86)\\dsh\\resources\\app.asar';
const B = process.argv[2];
function headerJson(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(16); fs.readSync(fd, head, 0, 16, 0);
  const headerSize = head.readUInt32LE(4);
  const pickle = Buffer.alloc(headerSize); fs.readSync(fd, pickle, 0, headerSize, 8);
  const jsonLen = pickle.readUInt32LE(4);
  const json = pickle.subarray(8, 8 + jsonLen).toString('utf8');
  fs.closeSync(fd);
  return json;
}
const a = JSON.parse(headerJson(A));
const b = JSON.parse(headerJson(B));
const ja = JSON.stringify(a);
const jb = JSON.stringify(b);
console.log('canonical equal:', ja === jb, 'len', ja.length, jb.length);
if (ja !== jb) {
  let i = 0; while (i < ja.length && ja[i] === jb[i]) i++;
  console.log('first diff at', i);
  console.log('A:', JSON.stringify(ja.slice(i - 120, i + 200)));
  console.log('B:', JSON.stringify(jb.slice(i - 120, i + 200)));
}
// compare per-path fields excluding offset/integrity
function flat(tree) {
  const out = new Map();
  (function walk(node, prefix) {
    for (const [name, e] of Object.entries(node.files)) {
      const p = prefix ? prefix + '/' + name : name;
      if (e.files) walk(e, p); else out.set(p, e);
    }
  })(tree, '');
  return out;
}
const fa = flat(a), fb = flat(b);
let diffs = 0;
for (const [p, ea] of fa) {
  const eb = fb.get(p);
  if (!eb) { console.log('missing in built', p); diffs++; continue; }
  if (ea.size !== eb.size) { console.log('size diff', p, ea.size, eb.size); diffs++; }
  if (ea.unpacked !== eb.unpacked) { console.log('unpacked diff', p, ea.unpacked, eb.unpacked); diffs++; }
  if (ea.integrity?.hash !== eb.integrity?.hash) { console.log('hash diff', p); diffs++; }
}
console.log('files', fa.size, fb.size, 'field diffs', diffs);
