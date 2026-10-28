import fs from 'node:fs';

export function readHeader(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const a = head.readUInt32LE(0);
  const headerSize = head.readUInt32LE(4);
  const b = head.readUInt16LE(8);
  const c = head.readUInt32LE(10);
  fs.closeSync(fd);
  return { a, headerSize, b, c };
}

if (process.argv[1] === import.meta.filename) {
  const asar = process.argv[2];
  const h = readHeader(asar);
  console.log(JSON.stringify(h));
  const fd = fs.openSync(asar, 'r');
  const headerBuf = Buffer.alloc(h.headerSize);
  fs.readSync(fd, headerBuf, 0, h.headerSize, 8);
  fs.closeSync(fd);
  console.log('headerBuf[0..8]', headerBuf.subarray(0, 8).toString('hex'));
  const len = headerBuf.readUInt32LE(4);
  console.log('jsonLen', len, 'bufLen', headerBuf.length);
  const json = headerBuf.subarray(8, 8 + len).toString('utf8');
  const tree = JSON.parse(json);
  console.log('top keys', Object.keys(tree), 'root keys count', Object.keys(tree.files).length);
  const main = tree.files.lib?.files?.['main.js'];
  console.log('lib/main.js entry', main);
  console.log('dsh dir?', !!tree.files.dsh);
  const stat = fs.statSync(asar);
  console.log('file size', stat.size);
}
