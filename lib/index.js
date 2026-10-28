import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildPatchedAsar, inspectPatchState } from './patch.js';

export const name = 'dsh-retry';
export const inject = ['webServer'];

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HELPER_SCRIPT = path.join(PACKAGE_ROOT, 'scripts', 'restart-helper.ps1');

/** Desktop layout derived from the running Electron executable. */
function desktopPaths() {
  if (!process.versions.electron) return null;
  const exe = process.execPath;
  if (!/DeepSeek Harness/i.test(path.basename(exe))) return null;
  const resources = path.join(path.dirname(exe), 'resources');
  const asar = path.join(resources, 'app.asar');
  if (!fs.existsSync(asar)) return null;
  return {
    exe,
    resources,
    asar,
    trigger: path.join(resources, 'dsh-retry.restart'),
    staging: path.join(os.tmpdir(), 'dsh-retry-build'),
    log: path.join(os.tmpdir(), 'dsh-retry-build', 'restart-helper.log'),
    backup: path.join(resources, 'app.asar.dsh-retry.bak'),
  };
}

function reply(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

function isPatched(state) {
  return Boolean(state && state.mainPatched && state.accountPatched);
}

function ensurePatchedAsar(paths, log) {
  const state = inspectPatchState(paths.asar);
  if (isPatched(state)) return null;
  fs.mkdirSync(paths.staging, { recursive: true });
  const staged = path.join(paths.staging, 'app.asar.patched');
  const metaPath = path.join(paths.staging, 'app.asar.patched.meta.json');
  const sourceStat = fs.statSync(paths.asar);
  const meta = {
    source: paths.asar,
    size: sourceStat.size,
    mtimeMs: sourceStat.mtimeMs,
  };
  if (fs.existsSync(staged) && fs.existsSync(metaPath)) {
    try {
      const previous = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const sameSource = previous.source === meta.source && previous.size === meta.size && previous.mtimeMs === meta.mtimeMs;
      if (sameSource && isPatched(inspectPatchState(staged))) {
        log('reusing staged patched asar');
        return { staged, built: false };
      }
    } catch {
      // fall through to a fresh build
    }
  }
  log('building patched app.asar');
  buildPatchedAsar(paths.asar, staged, { log });
  fs.writeFileSync(metaPath, JSON.stringify({ ...meta, builtAt: new Date().toISOString() }, null, 2));
  return { staged, built: true };
}

function launchHelper(paths, staged) {
  fs.mkdirSync(paths.staging, { recursive: true });
  fs.writeFileSync(
    paths.log,
    `[${new Date().toISOString()}] launching helper pid=${process.pid} mainPid=${process.ppid} staged=${staged ?? ''}\n`,
  );
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-WindowStyle',
    'Hidden',
    '-File',
    HELPER_SCRIPT,
    '-MainPid',
    String(process.ppid),
    '-AsarPath',
    paths.asar,
    '-PatchedAsar',
    staged ?? '',
    '-BackupPath',
    paths.backup,
    '-ExePath',
    paths.exe,
    '-LogPath',
    paths.log,
  ];
  const child = spawn('powershell.exe', args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx) {
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-retry/status',
      handler: async (req, res) => {
        try {
          const paths = desktopPaths();
          if (paths === null) return reply(res, 200, { ok: true, desktop: false });
          const state = inspectPatchState(paths.asar);
          return reply(res, 200, {
            ok: true,
            desktop: true,
            asar: paths.asar,
            patched: isPatched(state),
            mainPatched: Boolean(state.mainPatched),
            accountPatched: Boolean(state.accountPatched),
            mainPid: process.ppid,
          });
        } catch (error) {
          return reply(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }),
  );

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-retry/restart',
      handler: async (req, res) => {
        if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
        const log = (message) => fs.appendFileSync(path.join(os.tmpdir(), 'dsh-retry-build', 'restart.log'), `[${new Date().toISOString()}] ${message}\n`);
        try {
          const paths = desktopPaths();
          if (paths === null) return reply(res, 409, { ok: false, error: 'not_desktop' });
          fs.mkdirSync(paths.staging, { recursive: true });
          let staged = null;
          try {
            staged = ensurePatchedAsar(paths, log)?.staged ?? null;
          } catch (error) {
            log(`patch build failed: ${String(error?.message ?? error)}`);
            return reply(res, 500, { ok: false, error: `patch_failed: ${String(error?.message ?? error)}` });
          }
          if (staged === null) {
            reply(res, 200, { ok: true, mode: 'restart' });
            log('writing restart trigger');
            fs.writeFileSync(paths.trigger, new Date().toISOString());
            return;
          }
          reply(res, 200, { ok: true, mode: 'patch-and-restart', staged });
          log(`staged patched asar: ${staged}`);
          launchHelper(paths, staged);
        } catch (error) {
          return reply(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }),
  );
}
