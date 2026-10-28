import fs from 'node:fs';
const asar = process.argv[2];
const fd = fs.openSync(asar, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(4);
const pickleBuf = Buffer.alloc(headerSize);
fs.readSync(fd, pickleBuf, 0, headerSize, 8);
const jsonLen = pickleBuf.readUInt32LE(4);
const json = pickleBuf.subarray(8, 8 + jsonLen);
const text = json.toString('utf8');
console.log('json starts:', JSON.stringify(text.slice(0, 300)));
console.log('json ends:', JSON.stringify(text.slice(-200)));
const tree = JSON.parse(text);
const main = tree.files.lib.files['main.js'];
console.log('main entry raw', JSON.stringify(main));
// find entries where offset is number vs string
const counts = { str: 0, num: 0, none: 0 };
(function walk(node) {
  for (const [name, e] of Object.entries(node.files)) {
    if (e.files) walk(e);
    else if (e.offset === undefined) counts.none++;
    else if (typeof e.offset === 'string') counts.str++;
    else counts.num++;
  }
})(tree);
console.log(counts);
fs.closeSync(fd);
