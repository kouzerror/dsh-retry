import { readAsar, closeAsar, listFiles, readEntry, rebuildAsar, verifyAsar } from './asar.js';

export const MAIN_ENTRY = 'lib/main.js';
export const ACCOUNT_ENTRY = 'dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib/client.js';

/** Marker written into main.js; presence means the core patch is applied. */
export const MAIN_MARKER = 'dsh-retry.restart';
export const ACCOUNT_MARKER = 'dshRetryRestart';

function replaceOnce(source, anchor, replacement, label) {
  const first = source.indexOf(anchor);
  if (first < 0) throw new Error(`patch anchor not found: ${label}`);
  const second = source.indexOf(anchor, first + anchor.length);
  if (second >= 0) throw new Error(`patch anchor is not unique: ${label}`);
  return source.slice(0, first) + replacement + source.slice(first + anchor.length);
}

export function patchMain(text) {
  if (text.includes(MAIN_MARKER)) return { changed: false, text };

  let out = text;
  out = replaceOnce(out, 'restartApplication: "Restart",', 'restartApplication: "Restart DeepSeek Harness",', 'en tray restart label');
  out = replaceOnce(out, 'restartApplication: "重启",', 'restartApplication: "重启 DeepSeek Harness",', 'zh tray restart label');
  out = replaceOnce(
    out,
    '\t\t\t{\n' +
      '\t\t\t\tlabel: messages.quitApplication,\n' +
      '\t\t\t\tclick: () => {\n' +
      '\t\t\t\t\tthis.options.quit();\n' +
      '\t\t\t\t}\n' +
      '\t\t\t}\n' +
      '\t\t]));',
    '\t\t\t{\n' +
      '\t\t\t\tlabel: messages.restartApplication,\n' +
      '\t\t\t\tclick: () => {\n' +
      '\t\t\t\t\tapp.relaunch();\n' +
      '\t\t\t\t\tquitWithoutConfirmation();\n' +
      '\t\t\t\t}\n' +
      '\t\t\t},\n' +
      '\t\t\t{\n' +
      '\t\t\t\tlabel: messages.quitApplication,\n' +
      '\t\t\t\tclick: () => {\n' +
      '\t\t\t\t\tthis.options.quit();\n' +
      '\t\t\t\t}\n' +
      '\t\t\t}\n' +
      '\t\t]));',
    'tray menu restart item'
  );
  out = replaceOnce(
    out,
    'let quitting = false;',
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
      '\t}',
    'restart request watcher'
  );
  return { changed: true, text: out };
}

export function patchAccount(text) {
  if (text.includes(ACCOUNT_MARKER)) return { changed: false, text };

  let out = text;
  out = replaceOnce(
    out,
    '\t\t\t\t\t\t\t{\n' +
      '\t\t\t\t\t\t\t\tid: "contact",\n' +
      '\t\t\t\t\t\t\t\tlabel: t("contactUs"),\n' +
      '\t\t\t\t\t\t\t\ticon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPaperPlaneOutlineMedium, { size: 16 })\n' +
      '\t\t\t\t\t\t\t},',
    '\t\t\t\t\t\t\t{\n' +
      '\t\t\t\t\t\t\t\tid: "contact",\n' +
      '\t\t\t\t\t\t\t\tlabel: t("contactUs"),\n' +
      '\t\t\t\t\t\t\t\ticon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPaperPlaneOutlineMedium, { size: 16 })\n' +
      '\t\t\t\t\t\t\t},\n' +
      '\t\t\t\t\t\t\t{\n' +
      '\t\t\t\t\t\t\t\tid: "dsh-retry-restart",\n' +
      '\t\t\t\t\t\t\t\tlabel: t("dshRetryRestart"),\n' +
      '\t\t\t\t\t\t\t\ticon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconRefreshOutlineMedium, { size: 16 })\n' +
      '\t\t\t\t\t\t\t},',
    'account menu restart item'
  );
  out = replaceOnce(
    out,
    '\t\t\t\t\t\t\t} else if (id === "contact") {\n' +
      '\t\t\t\t\t\t\t\tsetOpen(false);\n' +
      '\t\t\t\t\t\t\t\tcontactUs();\n' +
      '\t\t\t\t\t\t\t} else if (id === "signin") beginSignIn();',
    '\t\t\t\t\t\t\t} else if (id === "contact") {\n' +
      '\t\t\t\t\t\t\t\tsetOpen(false);\n' +
      '\t\t\t\t\t\t\t\tcontactUs();\n' +
      '\t\t\t\t\t\t\t} else if (id === "dsh-retry-restart") {\n' +
      '\t\t\t\t\t\t\t\tsetOpen(false);\n' +
      '\t\t\t\t\t\t\t\tfetch(`${location.origin}/dsh-retry/restart`, { method: "POST" }).catch(() => {});\n' +
      '\t\t\t\t\t\t\t} else if (id === "signin") beginSignIn();',
    'account menu restart handler'
  );
  return { changed: true, text: out };
}

/**
 * Read the source asar, apply both patches, write a patched asar.
 * Returns { changed, patchedAsar, files }.
 */
export function buildPatchedAsar(sourceAsar, outAsar, { log = () => {} } = {}) {
  const archive = readAsar(sourceAsar);
  try {
    const entries = new Map(listFiles(archive.tree).map((entry) => [entry.path, entry]));
    const mainEntry = entries.get(MAIN_ENTRY);
    const accountEntry = entries.get(ACCOUNT_ENTRY);
    if (!mainEntry) throw new Error(`missing ${MAIN_ENTRY}`);
    if (!accountEntry) throw new Error(`missing ${ACCOUNT_ENTRY}`);

    const main = patchMain(readEntry(archive, mainEntry).toString('utf8'));
    const account = patchAccount(readEntry(archive, accountEntry).toString('utf8'));
    if (!main.changed && !account.changed) return { changed: false, patchedAsar: sourceAsar };

    const replacements = new Map();
    if (main.changed) replacements.set(MAIN_ENTRY, Buffer.from(main.text, 'utf8'));
    if (account.changed) replacements.set(ACCOUNT_ENTRY, Buffer.from(account.text, 'utf8'));

    log(`writing patched asar: ${outAsar}`);
    rebuildAsar(sourceAsar, outAsar, replacements);
    verifyAsar(outAsar, { deep: false });
    return { changed: true, patchedAsar: outAsar, entries };
  } finally {
    closeAsar(archive);
  }
}

export function inspectPatchState(sourceAsar) {
  const archive = readAsar(sourceAsar);
  try {
    const entries = new Map(listFiles(archive.tree).map((entry) => [entry.path, entry]));
    const mainEntry = entries.get(MAIN_ENTRY);
    if (!mainEntry) return { readable: false };
    const mainText = readEntry(archive, mainEntry).toString('utf8');
    const accountEntry = entries.get(ACCOUNT_ENTRY);
    const accountText = accountEntry ? readEntry(archive, accountEntry).toString('utf8') : '';
    return {
      readable: true,
      mainPatched: mainText.includes(MAIN_MARKER),
      accountPatched: accountText.includes(ACCOUNT_MARKER),
      mainSize: mainEntry.size,
      accountSize: accountEntry?.size ?? 0,
    };
  } finally {
    closeAsar(archive);
  }
}
