import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Resolve the desktop layout from the running Electron executable.
 * Returns null outside the Windows desktop app (web host, CLI, tests).
 */
export function desktopPaths({
  execPath = process.execPath,
  electron = process.versions.electron,
  tmpdir = os.tmpdir(),
} = {}) {
  if (!electron) return null;
  if (!/DeepSeek Harness/i.test(path.basename(execPath))) return null;
  const resources = path.join(path.dirname(execPath), 'resources');
  const asar = path.join(resources, 'app.asar');
  if (!fs.existsSync(asar)) return null;
  const staging = path.join(tmpdir, 'dsh-retry-build');
  return {
    exe: execPath,
    resources,
    asar,
    trigger: path.join(resources, 'dsh-retry.restart'),
    backup: path.join(resources, 'app.asar.dsh-retry.bak'),
    staging,
    helperLog: path.join(staging, 'restart-helper.log'),
    buildLog: path.join(staging, 'restart.log'),
    marker: path.join(staging, 'install-armed.json'),
    stagedAsar: path.join(staging, 'app.asar.patched'),
    stagedMeta: path.join(staging, 'app.asar.patched.meta.json'),
  };
}

/** Absolute path of Windows PowerShell, independent of PATH. */
export function powershellPath(env = process.env) {
  const root = env.SystemRoot || env.windir || 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
