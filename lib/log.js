import fs from 'node:fs';
import path from 'node:path';

/**
 * Append-only logger that never throws: logging must not break the restart path.
 * The returned value is directly callable (`log("message")`) and also exposes
 * `.file` and `.write` for callers that prefer the property form.
 */
export function createLogger(file) {
  const write = (message) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `[${new Date().toISOString()}] ${message}\n`);
    } catch {
      // ignored on purpose
    }
  };

  const log = (message) => write(message);
  log.file = file;
  log.write = write;
  return log;
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
