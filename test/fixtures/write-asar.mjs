import crypto from 'node:crypto';
import fs from 'node:fs';

const CHUNK = 4194304;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function integrity(buf) {
  const blocks = [];
  for (let i = 0; i < buf.length; i += CHUNK) blocks.push(sha256(buf.subarray(i, i + CHUNK)));
  if (blocks.length === 0) blocks.push(sha256(Buffer.alloc(0)));
  return { algorithm: 'SHA256', hash: sha256(buf), blockSize: CHUNK, blocks };
}

/**
 * Write a tiny but structurally faithful asar archive.
 * Kept independent from lib/asar.js so tests validate the reader against an
 * unrelated writer instead of a round-trip of itself.
 */
export function writeAsar(file, files) {
  const tree = { files: {} };
  const blobs = [];
  let offset = 0;
  const entries = [...files.entries()].map(([name, value]) => [name, Buffer.isBuffer(value) ? value : Buffer.from(value)]);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [name, buf] of entries) {
    const parts = name.split('/');
    let node = tree.files;
    for (const part of parts.slice(0, -1)) {
      node[part] ??= { files: {} };
      node = node[part].files;
    }
    node[parts.at(-1)] = { size: buf.length, offset: String(offset), integrity: integrity(buf) };
    blobs.push(buf);
    offset += buf.length;
  }
  const json = Buffer.from(JSON.stringify(tree), 'utf8');
  const headerSize = Math.ceil((8 + json.length) / 4) * 4;
  const header = Buffer.alloc(headerSize);
  header.writeUInt32LE(headerSize - 4, 0);
  header.writeUInt32LE(json.length, 4);
  json.copy(header, 8);
  const lead = Buffer.alloc(8);
  lead.writeUInt32LE(4, 0);
  lead.writeUInt32LE(headerSize, 4);
  fs.writeFileSync(file, Buffer.concat([lead, header, ...blobs]));
  return { files: entries.length, bytes: offset };
}
