import { spawn } from 'node:child_process';
import path from 'node:path';
import { powershellPath } from './desktop.js';

/**
 * Arguments for the PowerShell helper. Stage 1 launches itself through WMI so
 * the real worker survives the DSH process tree; -InstallOnly then waits for a
 * normal app exit instead of killing and relaunching it.
 */
export function helperArgs({ script, mainPid, paths, staged, installOnly = false }) {
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
  if (installOnly) args.push('-InstallOnly');
  return args;
}

/**
 * Spawn the helper launcher. Detached spawning is deliberately not used: on
 * this machine the detached child dies before PowerShell runs a single line.
 * The launcher re-creates itself via WMI instead (see restart-helper.ps1).
 */
export function launchHelper({ script, paths, staged, log, installOnly = false, mainPid = process.ppid }) {
  const args = helperArgs({ script, mainPid, paths, staged, installOnly });
  log(`launching helper pid=${process.pid} mainPid=${mainPid} staged=${staged ?? ''} installOnly=${installOnly}`);
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
