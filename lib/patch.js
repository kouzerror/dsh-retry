import { readAsar, closeAsar, listFiles, readEntry, rebuildAsar, verifyAsar, sha256 } from './asar.js';

export const MAIN_ENTRY = 'lib/main.js';
export const ACCOUNT_ENTRY = 'dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib/client.js';
export const DESKTOP_PACKAGE_ENTRY = 'package.json';

/** Marker written into main.js; presence means the restart watcher exists. */
export const MAIN_MARKER = 'dsh-retry.restart';
export const ACCOUNT_MARKER = 'dshRetryRestart';

export const MAIN_FEATURES = Object.freeze({
  enLabel: 'restartApplication: "Restart DeepSeek Harness"',
  zhLabel: 'restartApplication: "重启 DeepSeek Harness"',
  trayItem: 'label: messages.restartApplication',
  watcher: MAIN_MARKER,
});

export const ACCOUNT_FEATURES = Object.freeze({
  item: `id: "dsh-retry-restart"`,
  handler: 'id === "dsh-retry-restart"',
  enLabel: 'dshRetryRestart: "Restart DeepSeek Harness"',
  zhLabel: 'dshRetryRestart: "重启 DeepSeek Harness"',
});

const TRAY_QUIT_ANCHOR =
  '\t\t\t{\n' +
  '\t\t\t\tlabel: messages.quitApplication,\n' +
  '\t\t\t\tclick: () => {\n' +
  '\t\t\t\t\tthis.options.quit();\n' +
  '\t\t\t\t}\n' +
  '\t\t\t}\n' +
  '\t\t]));';

const TRAY_QUIT_WITH_RESTART =
  '\t\t\t{\n' +
  '\t\t\t\tlabel: messages.restartApplication,\n' +
  '\t\t\t\tclick: () => {\n' +
  '\t\t\t\t\tapp.relaunch();\n' +
  '\t\t\t\t\tquitWithoutConfirmation();\n' +
  '\t\t\t\t}\n' +
  '\t\t\t},\n' +
  TRAY_QUIT_ANCHOR;

const WATCHER_ANCHOR = 'let quitting = false;';
const WATCHER_CODE =
  'let quitting = false;\n' +
  '\t{\n' +
  '\t\tconst dshRetryTrigger = join(process.resourcesPath, "dsh-retry.restart");\n' +
  '\t\tconst dshRetryPoll = setInterval(() => {\n' +
  '\t\t\ttry {\n' +
  '\t\t\t\tif (!existsSync(dshRetryTrigger)) return;\n' +
  '\t\t\t\tunlinkSync(dshRetryTrigger);\n' +
  '\t\t\t} catch {\n' +
  '\t\t\t\treturn;\n' +
  '\t\t\t}\n' +
  '\t\t\tif (quitting) return;\n' +
  '\t\t\tapp.relaunch();\n' +
  '\t\t\tquitWithoutConfirmation();\n' +
  '\t\t}, 800);\n' +
  '\t\tdshRetryPoll.unref?.();\n' +
  '\t}';

const ACCOUNT_CONTACT_ITEM =
  '\t\t\t\t\t\t\t{\n' +
  '\t\t\t\t\t\t\t\tid: "contact",\n' +
  '\t\t\t\t\t\t\t\tlabel: t("contactUs"),\n' +
  '\t\t\t\t\t\t\t\ticon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPaperPlaneOutlineMedium, { size: 16 })\n' +
  '\t\t\t\t\t\t\t},';

const ACCOUNT_RESTART_ITEM =
  '\t\t\t\t\t\t\t{\n' +
  '\t\t\t\t\t\t\t\tid: "dsh-retry-restart",\n' +
  '\t\t\t\t\t\t\t\tlabel: t("dshRetryRestart"),\n' +
  '\t\t\t\t\t\t\t\ticon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconRefreshOutlineMedium, { size: 16 })\n' +
  '\t\t\t\t\t\t\t},';

const ACCOUNT_SELECT_ANCHOR =
  '\t\t\t\t\t\t\t} else if (id === "contact") {\n' +
  '\t\t\t\t\t\t\t\tsetOpen(false);\n' +
  '\t\t\t\t\t\t\t\tcontactUs();\n' +
  '\t\t\t\t\t\t\t} else if (id === "signin") beginSignIn();';

const ACCOUNT_SELECT_WITH_RESTART =
  '\t\t\t\t\t\t\t} else if (id === "contact") {\n' +
  '\t\t\t\t\t\t\t\tsetOpen(false);\n' +
  '\t\t\t\t\t\t\t\tcontactUs();\n' +
  '\t\t\t\t\t\t\t} else if (id === "dsh-retry-restart") {\n' +
  '\t\t\t\t\t\t\t\tsetOpen(false);\n' +
  '\t\t\t\t\t\t\t\tfetch(`${location.origin}/dsh-retry/restart`, { method: "POST" }).catch(() => {});\n' +
  '\t\t\t\t\t\t\t} else if (id === "signin") beginSignIn();';

/**
 * Replace exactly one occurrence; a missing or duplicated anchor means the
 * target bundle changed shape, so fail loudly instead of writing a half patch.
 */
function replaceOnce(source, anchor, replacement, label) {
  const first = source.indexOf(anchor);
  if (first < 0) throw new Error(`patch anchor not found: ${label} (DSH version unsupported?)`);
  const second = source.indexOf(anchor, first + anchor.length);
  if (second >= 0) throw new Error(`patch anchor is not unique: ${label}`);
  return source.slice(0, first) + replacement + source.slice(first + anchor.length);
}

function missingFeatures(text, features) {
  return Object.entries(features)
    .filter(([, marker]) => !text.includes(marker))
    .map(([name]) => name);
}

/**
 * Patch the Electron main process. Every feature is applied independently and
 * guarded by its own marker, so an archive patched by an older plugin version
 * can be completed without duplicating entries.
 */
export function patchMain(text) {
  let out = text;
  const applied = [];

  if (!out.includes(MAIN_FEATURES.enLabel)) {
    out = replaceOnce(out, 'restartApplication: "Restart",', MAIN_FEATURES.enLabel + ',', 'en tray restart label');
    applied.push('enLabel');
  }
  if (!out.includes(MAIN_FEATURES.zhLabel)) {
    out = replaceOnce(out, 'restartApplication: "重启",', MAIN_FEATURES.zhLabel + ',', 'zh tray restart label');
    applied.push('zhLabel');
  }
  if (!out.includes(MAIN_FEATURES.trayItem)) {
    out = replaceOnce(out, TRAY_QUIT_ANCHOR, TRAY_QUIT_WITH_RESTART, 'tray menu restart item');
    applied.push('trayItem');
  }
  if (!out.includes(MAIN_FEATURES.watcher)) {
    out = replaceOnce(out, WATCHER_ANCHOR, WATCHER_CODE, 'restart request watcher');
    applied.push('watcher');
  }
  return { changed: applied.length > 0, text: out, applied, missing: missingFeatures(out, MAIN_FEATURES) };
}

/** Patch the settings-account client bundle that renders the account popup. */
export function patchAccount(text) {
  let out = text;
  const applied = [];

  if (!out.includes(ACCOUNT_FEATURES.item)) {
    out = replaceOnce(out, ACCOUNT_CONTACT_ITEM, ACCOUNT_CONTACT_ITEM + '\n' + ACCOUNT_RESTART_ITEM, 'account menu restart item');
    applied.push('item');
  }
  if (!out.includes(ACCOUNT_FEATURES.handler)) {
    out = replaceOnce(out, ACCOUNT_SELECT_ANCHOR, ACCOUNT_SELECT_WITH_RESTART, 'account menu restart handler');
    applied.push('handler');
  }
  if (!out.includes(ACCOUNT_FEATURES.enLabel)) {
    out = replaceOnce(
      out,
      '\t\t\tsettings: "Settings",',
      '\t\t\tsettings: "Settings",\n\t\t\tdshRetryRestart: "Restart DeepSeek Harness",',
      'account menu en label'
    );
    applied.push('enLabel');
  }
  if (!out.includes(ACCOUNT_FEATURES.zhLabel)) {
    out = replaceOnce(
      out,
      '\t\t\tsettings: "设置",',
      '\t\t\tsettings: "设置",\n\t\t\tdshRetryRestart: "重启 DeepSeek Harness",',
      'account menu zh label'
    );
    applied.push('zhLabel');
  }
  return { changed: applied.length > 0, text: out, applied, missing: missingFeatures(out, ACCOUNT_FEATURES) };
}

function readText(archive, entryPath) {
  const entry = listFiles(archive.tree).find((candidate) => candidate.path === entryPath);
  if (entry === undefined) return null;
  return readEntry(archive, entry).toString('utf8');
}

/**
 * Read the source asar, apply both patches and write a freshly built archive.
 * The output is structurally verified and each patched entry is read back, so a
 * silent half-patch can never reach the installer.
 */
export function buildPatchedAsar(sourceAsar, outAsar, { log = () => {} } = {}) {
  const archive = readAsar(sourceAsar);
  try {
    const mainBefore = readText(archive, MAIN_ENTRY);
    const accountBefore = readText(archive, ACCOUNT_ENTRY);
    if (mainBefore === null) throw new Error(`missing ${MAIN_ENTRY}`);
    if (accountBefore === null) throw new Error(`missing ${ACCOUNT_ENTRY}`);

    const main = patchMain(mainBefore);
    const account = patchAccount(accountBefore);
    log(`patch plan: main=[${main.applied.join(',')}] account=[${account.applied.join(',')}]`);
    if (!main.changed && !account.changed) {
      return { changed: false, patchedAsar: null, files: 0, note: 'already patched' };
    }

    const replacements = new Map();
    replacements.set(MAIN_ENTRY, Buffer.from(main.text, 'utf8'));
    replacements.set(ACCOUNT_ENTRY, Buffer.from(account.text, 'utf8'));
    rebuildAsar(sourceAsar, outAsar, replacements, { log });
  } finally {
    closeAsar(archive);
  }

  const verification = verifyAsar(outAsar, { deep: true });
  if (!verification.ok) throw new Error(`patched asar failed verification: ${verification.problems.slice(0, 5).join('; ')}`);
  const patched = inspectPatchState(outAsar);
  if (!patched.readable || !patched.mainPatched || !patched.accountPatched) {
    throw new Error(`patched asar is incomplete: main=${patched.mainPatched} account=${patched.accountPatched}`);
  }
  log(`patched asar verified: ${verification.stored} stored files, ${verification.storedBytes} bytes`);
  return { changed: true, patchedAsar: outAsar, files: verification.files, bytes: verification.storedBytes };
}

/** Read-only description of the installed archive; used by the status route. */
export function inspectPatchState(sourceAsar) {
  let archive;
  try {
    archive = readAsar(sourceAsar);
  } catch (error) {
    return { readable: false, error: String(error?.message ?? error) };
  }
  try {
    const mainText = readText(archive, MAIN_ENTRY);
    const accountText = readText(archive, ACCOUNT_ENTRY);
    if (mainText === null) return { readable: false, error: `missing ${MAIN_ENTRY}` };
    const desktopPackage = readText(archive, DESKTOP_PACKAGE_ENTRY);
    let desktopVersion = null;
    try {
      desktopVersion = JSON.parse(desktopPackage ?? '{}').version ?? null;
    } catch {
      desktopVersion = null;
    }
    const mainMissing = missingFeatures(mainText, MAIN_FEATURES);
    const accountMissing = accountText === null ? Object.keys(ACCOUNT_FEATURES) : missingFeatures(accountText, ACCOUNT_FEATURES);
    return {
      readable: true,
      desktopVersion,
      mainPatched: mainMissing.length === 0,
      accountPatched: accountMissing.length === 0,
      mainMissing,
      accountMissing,
      mainSha256: sha256(Buffer.from(mainText, 'utf8')),
      accountSha256: accountText === null ? null : sha256(Buffer.from(accountText, 'utf8')),
      mainSize: Buffer.byteLength(mainText),
      accountSize: accountText === null ? 0 : Buffer.byteLength(accountText),
    };
  } finally {
    closeAsar(archive);
  }
}
