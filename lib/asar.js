// Minimal ASAR reader/rebuilder used by dsh-retry to patch the DeepSeek Harness
// desktop shell (resources/app.asar).
//
// On-disk layout (Chromium pickle + JSON header):
//   uint32(4)            pickle header marker
//   uint32(headerSize)   size of the pickled header in bytes
//   header[0..4]         payload size (headerSize - 4)
//   header[4..8]         JSON length
//   header[8..8+jsonLen] compact JSON tree
//   header[8+jsonLen..]  NUL padding up to headerSize
// File data starts at 8 + headerSize; every stored entry offset is relative to
// that position, and stored data is contiguous in ascending offset order.
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Inside Electron the patched `node:fs` treats any "*.asar" path as a virtual
// directory and refuses to open the archive itself. `original-fs` bypasses that
// layer, which is the only way to read/write the archive as a plain file.
let fsImpl;
try {
  fsImpl = require('original-fs');
} catch {
  fsImpl = require('node:fs');
}
const fs = fsImpl;

const CHUNK = 4194304;
const LEAD_SIZE = 8;
const HEADER_PREFIX = 8; // marker + length fields inside the pickled header

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function readAt(fd, position, length) {
  const buf = Buffer.alloc(length);
  const read = fs.readSync(fd, buf, 0, length, position);
  if (read !== length) throw new Error(`short read: wanted ${length} bytes at ${position}, got ${read}`);
  return buf;
}

/** Open an asar and parse its header. Call closeAsar() when done. */
export function readAsar(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size < LEAD_SIZE + 12) throw new Error(`not an asar archive: ${file} (${size} bytes)`);
    const lead = readAt(fd, 0, LEAD_SIZE);
    const pickleMarker = lead.readUInt32LE(0);
    const headerSize = lead.readUInt32LE(4);
    if (pickleMarker !== 4) throw new Error(`invalid asar lead: marker=${pickleMarker}`);
    if (headerSize < 12 || headerSize > size - LEAD_SIZE) {
      throw new Error(`invalid asar header: headerSize=${headerSize} file=${size}`);
    }
    const header = readAt(fd, LEAD_SIZE, headerSize);
    const payloadSize = header.readUInt32LE(0);
    const jsonLen = header.readUInt32LE(4);
    if (payloadSize !== headerSize - 4) {
      throw new Error(`invalid asar header: payloadSize=${payloadSize} headerSize=${headerSize}`);
    }
    if (jsonLen <= 0 || HEADER_PREFIX + jsonLen > headerSize) {
      throw new Error(`invalid asar header: jsonLen=${jsonLen} headerSize=${headerSize}`);
    }
    const json = header.subarray(HEADER_PREFIX, HEADER_PREFIX + jsonLen).toString('utf8');
    const tree = JSON.parse(json);
    const dataStart = LEAD_SIZE + headerSize;
    if (dataStart > size) throw new Error(`invalid asar: data starts past EOF`);
    return { file, fd, size, headerSize, jsonLen, dataStart, tree };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

export function closeAsar(archive) {
  if (archive.fd !== undefined) {
    fs.closeSync(archive.fd);
    archive.fd = undefined;
  }
}

/** Flat list of stored file entries in data order (offset ascending). */
export function listFiles(tree) {
  const files = [];
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (entry.files) walk(entry, p);
      else files.push({ path: p, ...entry });
    }
  };
  walk(tree, '');
  const stored = files.filter((entry) => entry.offset !== undefined);
  for (const entry of stored) entry.offset = Number(entry.offset);
  stored.sort((a, b) => a.offset - b.offset);
  return stored;
}

export function findEntry(tree, entryPath) {
  let node = tree;
  for (const part of entryPath.split('/')) {
    node = node.files?.[part];
    if (node === undefined) return undefined;
  }
  return node.files ? undefined : node;
}

export function entryPathSet(tree) {
  return new Set(listFiles(tree).map((entry) => entry.path));
}

export function readEntry(archive, entry) {
  const size = Number(entry.size);
  if (entry.offset === undefined) throw new Error(`${entry.path ?? 'entry'} is unpacked; content lives in app.asar.unpacked`);
  if (size === 0) return Buffer.alloc(0);
  const start = archive.dataStart + Number(entry.offset);
  if (start + size > archive.size) throw new Error(`${entry.path ?? 'entry'} extends past EOF`);
  return readAt(archive.fd, start, size);
}

function integrityFor(buf) {
  const blocks = [];
  for (let i = 0; i < buf.length; i += CHUNK) blocks.push(sha256(buf.subarray(i, i + CHUNK)));
  // Electron's packer records one block for an empty file as well.
  if (blocks.length === 0) blocks.push(sha256(Buffer.alloc(0)));
  return { algorithm: 'SHA256', hash: sha256(buf), blockSize: CHUNK, blocks };
}

/** Structural summary used in status output and tests. */
export function summarize(tree) {
  const list = listFiles(tree);
  let storedBytes = 0;
  for (const entry of list) storedBytes += Number(entry.size);
  const all = [];
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (entry.files) walk(entry, p);
      else all.push(p);
    }
  };
  walk(tree, '');
  return {
    files: all.length,
    stored: list.length,
    unpacked: all.length - list.length,
    storedBytes,
  };
}

/**
 * Rebuild the archive, replacing the contents of the given entries.
 * Stored files keep their relative order; offsets and integrity are recomputed
 * from the bytes actually written. Unpacked entries are copied through untouched.
 */
export function rebuildAsar(sourceFile, outFile, replacements = new Map(), { log = () => {} } = {}) {
  const archive = readAsar(sourceFile);
  try {
    const stored = listFiles(archive.tree);
    const known = new Set(stored.map((entry) => entry.path));
    for (const key of replacements.keys()) {
      if (!known.has(key)) throw new Error(`asar has no stored entry ${key}`);
    }
    const blobs = [];
    let offset = 0;
    for (const entry of stored) {
      const replacement = replacements.get(entry.path);
      const buf = replacement !== undefined ? Buffer.from(replacement) : readEntry(archive, entry);
      entry.newSize = buf.length;
      entry.newOffset = offset;
      entry.integrity = integrityFor(buf);
      blobs.push(buf);
      offset += buf.length;
    }

    const tree = structuredClone(archive.tree);
    const byPath = new Map(stored.map((entry) => [entry.path, entry]));
    const walk = (node, prefix) => {
      for (const [name, entry] of Object.entries(node.files ?? {})) {
        const p = prefix ? `${prefix}/${name}` : name;
        if (entry.files) { walk(entry, p); continue; }
        const next = byPath.get(p);
        if (next === undefined) continue;
        entry.size = next.newSize;
        entry.offset = String(next.newOffset);
        entry.integrity = next.integrity;
      }
    };
    walk(tree, '');

    const json = Buffer.from(JSON.stringify(tree), 'utf8');
    const headerSize = Math.ceil((HEADER_PREFIX + json.length) / 4) * 4;
    const header = Buffer.alloc(headerSize);
    header.writeUInt32LE(headerSize - 4, 0);
    header.writeUInt32LE(json.length, 4);
    json.copy(header, HEADER_PREFIX);

    const fd = fs.openSync(outFile, 'w');
    try {
      const lead = Buffer.alloc(LEAD_SIZE);
      lead.writeUInt32LE(4, 0);
      lead.writeUInt32LE(headerSize, 4);
      fs.writeSync(fd, lead);
      fs.writeSync(fd, header);
      for (const buf of blobs) fs.writeSync(fd, buf);
    } finally {
      fs.closeSync(fd);
    }
    log(`rebuilt asar: ${stored.length} stored files, ${offset} bytes -> ${outFile}`);
    return { outFile, headerSize, jsonLen: json.length, files: stored.length, bytes: offset };
  } finally {
    closeAsar(archive);
  }
}

/** Extract one entry's bytes, without keeping the archive open. */
export function extractEntry(file, entryPath) {
  const archive = readAsar(file);
  try {
    const entry = findEntry(archive.tree, entryPath);
    if (entry === undefined) throw new Error(`asar has no entry ${entryPath}`);
    return readEntry(archive, { ...entry, path: entryPath });
  } finally {
    closeAsar(archive);
  }
}

/** Structural validation of a built archive: header parses, layout is contiguous, hashes match. */
export function verifyAsar(file, { deep = false } = {}) {
  const archive = readAsar(file);
  const problems = [];
  let expected = 0;
  const stored = listFiles(archive.tree);
  for (const entry of stored) {
    if (entry.offset !== expected) problems.push(`${entry.path}: offset ${entry.offset} != ${expected}`);
    expected = entry.offset + Number(entry.size);
    if (archive.dataStart + expected > archive.size) problems.push(`${entry.path}: extends past EOF`);
  }
  if (archive.dataStart + expected !== archive.size) {
    problems.push(`trailing data: expected end ${archive.dataStart + expected}, file ${archive.size}`);
  }
  if (deep) {
    for (const entry of stored) {
      const buf = readEntry(archive, entry);
      if (sha256(buf) !== entry.integrity?.hash) problems.push(`${entry.path}: integrity mismatch`);
    }
  }
  const summary = summarize(archive.tree);
  closeAsar(archive);
  return { ok: problems.length === 0, problems, ...summary };
}

export function defaultAsarPath(execPath = process.execPath) {
  return path.join(path.dirname(execPath), 'resources', 'app.asar');
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename;
if (invokedDirectly) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'list') {
    const archive = readAsar(args[0]);
    const stored = listFiles(archive.tree);
    console.log(stored.length, 'stored files');
    for (const entry of stored.slice(0, Number(args[1] ?? 20))) console.log(entry.path, entry.size);
    closeAsar(archive);
  } else if (cmd === 'verify') {
    console.log(JSON.stringify(verifyAsar(args[0], { deep: args[1] === 'deep' }), null, 2));
  } else if (cmd === 'extract') {
    const buf = extractEntry(args[0], args[1]);
    fs.writeFileSync(args[2], buf);
    console.log('wrote', args[2], buf.length);
  } else {
    console.log('usage: list <asar> [n] | verify <asar> [deep] | extract <asar> <entry> <out>');
    process.exitCode = 2;
  }
}
