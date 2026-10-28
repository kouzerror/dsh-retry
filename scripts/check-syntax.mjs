import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const targets = [
  ...fs.readdirSync(path.join(root, 'lib')).filter((name) => name.endsWith('.js')).map((name) => path.join('lib', name)),
  ...fs.readdirSync(path.join(root, 'scripts')).filter((name) => name.endsWith('.mjs')).map((name) => path.join('scripts', name)),
  ...fs.readdirSync(path.join(root, 'test')).filter((name) => name.endsWith('.js')).map((name) => path.join('test', name)),
];

let failed = 0;
for (const target of targets) {
  try {
    execFileSync(process.execPath, ['--check', path.join(root, target)], { stdio: 'pipe' });
    console.log(`ok   ${target}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${target}`);
    console.error(String(error.stderr ?? error.message));
  }
}
if (failed > 0) process.exitCode = 1;
