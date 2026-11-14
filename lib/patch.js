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

/**
 * Markers for the account popup patch. DSH 0.2.2 ships that bundle minified, so
 * the markers match quote style and spacing instead of exact bytes.
 */
export const ACCOUNT_FEATURES = Object.freeze({
  item: /\{[\s]*id:\s*["'`]dsh-retry-restart["'`]/,
  handler: /id\s*===\s*["'`]dsh-retry-restart["'`]/,
  labels: /dshRetryRestart:/,
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

const ACCOUNT_CONTACT_ITEM = /\{[\s]*id:\s*(["'`])contact\1/;
const ACCOUNT_CONTACT_HANDLER = /id\s*===\s*(["'`])contact\1/;
const ACCOUNT_CONTACT_LOCALE = /contactUs:\s*(["'`])([^"'`]*)\1,/g;
/** Locale text of the restart item, recognised by that locale's `contactUs` label. */
const ACCOUNT_LABELS = Object.freeze([
  [/[\u3400-\u9fff]/, '重启 DeepSeek Harness'],
  [/^Comentarios$/, 'Reiniciar DeepSeek Harness'],
  [/^Commentaires$/, 'Redémarrer DeepSeek Harness'],
  [/^Rückmeldung$/, 'DeepSeek Harness neu starten'],
  [/^Обратная связь$/, 'Перезапустить DeepSeek Harness'],
  [/^Comentários$/, 'Reiniciar o DeepSeek Harness'],
]);
const ACCOUNT_LABEL_FALLBACK = 'Restart DeepSeek Harness';

/** Index just past the braced block opened at `open`, skipping string bodies. */
function blockEnd(text, open) {
  if (text[open] !== '{') throw new Error('internal: blockEnd expects an opening brace');
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' || char === "'" || char === '`') {
      index = skipString(text, index);
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  throw new Error('unterminated block in the account bundle (DSH version unsupported?)');
}

/** Index of the quote that closes the string starting at `start`. */
function skipString(text, start) {
  const quote = text[start];
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === quote) return index;
    if (quote === '`' && char === '$' && text[index + 1] === '{') {
      index = blockEnd(text, index + 1) - 1;
    }
  }
  throw new Error('unterminated string in the account bundle (DSH version unsupported?)');
}

/**
 * Derive the restart item from the neighbouring `contact` item. Cloning the
 * existing entry keeps whatever jsx-runtime alias, icon namespace and spacing
 * the running build uses, which is what lets this survive minification.
 */
function insertMenuItem(text) {
  const match = ACCOUNT_CONTACT_ITEM.exec(text);
  if (match === null) throw new Error('patch anchor not found: account menu contact item (DSH version unsupported?)');
  const start = match.index;
  const end = blockEnd(text, start);
  const item = text
    .slice(start, end)
    .replace(/id:(\s*)(["'`])contact\2/, 'id:$1$2dsh-retry-restart$2')
    .replace(/t\((["'`])contactUs\1\)/, 't($1dshRetryRestart$1)')
    .replace(/IconPaperPlaneOutlineMedium/g, 'IconRefreshOutlineMedium');
  if (!item.includes('dsh-retry-restart') || !item.includes('dshRetryRestart') || !item.includes('IconRefreshOutlineMedium')) {
    throw new Error('patch anchor not found: account menu contact item shape (DSH version unsupported?)');
  }
  return `${text.slice(0, end)},${item}${text.slice(end)}`;
}

/** Append an `else if` branch for the restart item after the contact branch. */
function insertMenuHandler(text) {
  const match = ACCOUNT_CONTACT_HANDLER.exec(text);
  if (match === null) throw new Error('patch anchor not found: account menu contact handler (DSH version unsupported?)');
  const quote = match[1];
  const open = text.indexOf('{', match.index + match[0].length);
  if (open < 0) throw new Error('patch anchor not found: account menu contact block (DSH version unsupported?)');
  const end = blockEnd(text, open);
  const branch =
    ` else if(id===${quote}dsh-retry-restart${quote}){setOpen(false);` +
    "fetch(location.origin + '/dsh-retry/restart', { method: 'POST' }).catch(() => {})}";
  return text.slice(0, end) + branch + text.slice(end);
}

/**
 * Give every locale map a `dshRetryRestart` label in its own language, keeping
 * the surrounding style: minified maps stay on one line, pretty-printed maps
 * keep their indentation.
 */
function insertLocaleLabels(text) {
  return text.replace(ACCOUNT_CONTACT_LOCALE, (entry, quote, value, offset) => {
    const known = ACCOUNT_LABELS.find(([pattern]) => pattern.test(value));
    const label = known === undefined ? ACCOUNT_LABEL_FALLBACK : known[1];
    const lineStart = text.lastIndexOf('\n', offset);
    const indent = text.slice(lineStart + 1, offset);
    const lead = lineStart >= 0 && /^[ \t]*$/.test(indent) ? `\n${indent}` : '';
    const gap = quote === '`' ? '' : ' ';
    return `${entry}${lead}dshRetryRestart:${gap}${quote}${label}${quote},`;
  });
}

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

/** Presence check that accepts both byte markers and quote-agnostic patterns. */
function hasMarker(text, marker) {
  if (marker instanceof RegExp) {
    marker.lastIndex = 0;
    return marker.test(text);
  }
  return text.includes(marker);
}

function missingFeatures(text, features) {
  return Object.entries(features)
    .filter(([, marker]) => !hasMarker(text, marker))
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

  if (!hasMarker(out, ACCOUNT_FEATURES.item)) {
    out = insertMenuItem(out);
    applied.push('item');
  }
  if (!hasMarker(out, ACCOUNT_FEATURES.handler)) {
    out = insertMenuHandler(out);
    applied.push('handler');
  }
  if (!hasMarker(out, ACCOUNT_FEATURES.labels)) {
    out = insertLocaleLabels(out);
    applied.push('labels');
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
