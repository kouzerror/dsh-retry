// Minimal ASAR reader/rebuilder used by dsh-retry to patch the DeepSeek Harness
// desktop shell (app.asar). Format reference: Electron's `asar` archive.
//
// Layout: uint32(4) | uint32(headerSize) | uint32(headerSize) | uint32(jsonLen)
//         | header JSON | NUL padding to headerSize
// dataStart = 8 + headerSize; every stored file offset is relative to dataStart.
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

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function readAsar(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const headerSize = head.readUInt32LE(4);
    const pickle = Buffer.alloc(headerSize);
    fs.readSync(fd, pickle, 0, headerSize, 8);
    const jsonLen = pickle.readUInt32LE(4);
    if (jsonLen <= 0 || 8 + jsonLen > headerSize + 8) throw new Error(`invalid asar header: jsonLen=${jsonLen} headerSize=${headerSize}`);
    const json = pickle.subarray(8, 8 + jsonLen).toString('utf8');
    const tree = JSON.parse(json);
    return { file, fd, size, headerSize, jsonLen, dataStart: 8 + headerSize, tree };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

export function closeAsar(archive) {
  if (archive.fd !== undefined) fs.closeSync(archive.fd);
  archive.fd = undefined;
}

/** Flat list of file entries in stored data order (offset ascending). */
export function listFiles(tree) {
  const files = [];
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files)) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (entry.files) walk(entry, p);
      else files.push({ path: p, ...entry });
    }
  };
  walk(tree, '');
  const stored = files.filter((e) => e.offset !== undefined);
  stored.forEach((e) => { e.offset = Number(e.offset); });
  stored.sort((a, b) => a.offset - b.offset);
  return stored;
}

export function readEntry(archive, entry) {
  const buf = Buffer.alloc(entry.size);
  fs.readSync(archive.fd, buf, 0, entry.size, archive.dataStart + entry.offset);
  return buf;
}

function integrityFor(buf) {
  const blocks = [];
  for (let i = 0; i < buf.length; i += CHUNK) blocks.push(sha256(buf.subarray(i, i + CHUNK)));
  // Electron's packer records one block for an empty file as well.
  if (blocks.length === 0) blocks.push(sha256(Buffer.alloc(0)));
  return { algorithm: 'SHA256', hash: sha256(buf), blockSize: CHUNK, blocks };
}

/**
 * Rebuild the archive, replacing the contents of the given paths.
 * Every stored file keeps its original order; offsets and integrity are
 * recomputed from the actual bytes so patched files stay consistent.
 */
export function rebuildAsar(sourceFile, outFile, replacements = new Map()) {
  const archive = readAsar(sourceFile);
  try {
    const stored = listFiles(archive.tree);
    const known = new Set(stored.map((e) => e.path));
    for (const key of replacements.keys()) {
      if (!known.has(key)) throw new Error(`asar has no entry ${key}`);
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
    const byPath = new Map(stored.map((e) => [e.path, e]));
    const walk = (node, prefix) => {
      for (const [name, entry] of Object.entries(node.files)) {
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
    const headerSize = Math.ceil((8 + json.length) / 4) * 4;
    const header = Buffer.alloc(headerSize);
    // Chromium pickle: payload size excludes its own uint32 field.
    header.writeUInt32LE(headerSize - 4, 0);
    header.writeUInt32LE(json.length, 4);
    json.copy(header, 8);

    const fd = fs.openSync(outFile, 'w');
    try {
      const lead = Buffer.alloc(8);
      lead.writeUInt32LE(4, 0);
      lead.writeUInt32LE(headerSize, 4);
      fs.writeSync(fd, lead);
      fs.writeSync(fd, header);
      for (const buf of blobs) fs.writeSync(fd, buf);
    } finally {
      fs.closeSync(fd);
    }
    return { outFile, headerSize, jsonLen: json.length, files: stored.length, bytes: offset };
  } finally {
    closeAsar(archive);
  }
}

/** Extract one entry's bytes, without keeping the archive open. */
export function extractEntry(file, entryPath) {
  const archive = readAsar(file);
  try {
    const entry = listFiles(archive.tree).find((e) => e.path === entryPath);
    if (entry === undefined) throw new Error(`asar has no entry ${entryPath}`);
    return readEntry(archive, entry);
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
    expected = entry.offset + entry.size;
    if (archive.dataStart + expected > archive.size) problems.push(`${entry.path}: extends past EOF`);
  }
  if (archive.dataStart + expected !== archive.size) problems.push(`trailing data: expected end ${archive.dataStart + expected}, file ${archive.size}`);
  if (deep) {
    for (const entry of stored) {
      const buf = readEntry(archive, entry);
      if (sha256(buf) !== entry.integrity?.hash) problems.push(`${entry.path}: integrity mismatch`);
    }
  }
  closeAsar(archive);
  return { ok: problems.length === 0, problems, files: stored.length };
}

export function findEntry(tree, entryPath) {
  const parts = entryPath.split('/');
  let node = tree;
  for (const part of parts) {
    node = node.files?.[part];
    if (node === undefined) return undefined;
  }
  return node.files ? undefined : node;
}

export function entryPathSet(tree) {
  return new Set(listFiles(tree).map((e) => e.path));
}

export function defaultAsarPath(execPath = process.execPath) {
  return path.join(path.dirname(execPath), 'resources', 'app.asar');
}

if (process.argv[1] === import.meta.filename) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'list') {
    const archive = readAsar(args[0]);
    const stored = listFiles(archive.tree);
    console.log(stored.length, 'stored files');
    for (const e of stored.slice(0, Number(args[1] ?? 20))) console.log(e.path, e.size);
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
