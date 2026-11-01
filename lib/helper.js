import { spawn } from 'node:child_process';
import path from 'node:path';
import { powershellPath } from './desktop.js';

/**
 * Arguments for the PowerShell helper. Stage 1 launches itself through WMI so
 * the real worker survives the DSH process tree; the worker then stops the app,
 * swaps the archive and relaunches it.
 */
export function helperArgs({ script, mainPid, paths, staged, expected = null }) {
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-WindowStyle',
    'Hidden',
    '-File',
    script,
    '-MainPid',
    String(mainPid),
    '-AsarPath',
    paths.asar,
    '-PatchedAsar',
    staged ?? '',
    '-BackupPath',
    paths.backup,
    '-ExePath',
    paths.exe,
    '-LogPath',
    paths.helperLog,
  ];
  if (expected !== null) {
    args.push('-ExpectedAsarSize', String(expected.size), '-ExpectedAsarMtimeMs', String(Math.trunc(expected.mtimeMs)));
  }
  return args;
}

/**
 * Spawn the helper launcher. Detached spawning is deliberately not used: on
 * this machine the detached child dies before PowerShell runs a single line.
 * The launcher re-creates itself via WMI instead (see restart-helper.ps1).
 */
export function launchHelper({ script, paths, staged, log, mainPid = process.ppid, expected = null }) {
  const args = helperArgs({ script, mainPid, paths, staged, expected });
  log(`launching helper mainPid=${mainPid} staged=${staged ?? ''}`);
  const child = spawn(powershellPath(), args, { detached: false, stdio: 'ignore', windowsHide: true });
  child.on('error', (error) => log(`helper spawn error: ${error.code ?? ''} ${error.message}`));
  child.on('exit', (code, signal) => log(`helper launcher exit code=${code} signal=${signal ?? ''}`));
  log(`helper launcher pid=${child.pid ?? 'unknown'}`);
  child.unref();
  return child;
}

/** Absolute path of the bundled helper script for a package root. */
export function helperScript(packageRoot) {
  return path.join(packageRoot, 'scripts', 'restart-helper.ps1');
}