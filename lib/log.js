import fs from 'node:fs';
import path from 'node:path';

/** Append-only log that never throws: logging must not break the restart path. */
export function createLogger(file) {
  return {
    file,
    write(message) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `[${new Date().toISOString()}] ${message}\n`);
      } catch {
        // ignored on purpose
      }
    },
  };
}

/** Last lines of a log file, used by the status route and bug reports. */
export function readTail(file, lines = 8) {
  try {
    const text = fs.readFileSync(file, 'utf8').trimEnd();
    if (text === '') return [];
    return text.split('\n').slice(-lines);
  } catch {
    return [];
  }
}
