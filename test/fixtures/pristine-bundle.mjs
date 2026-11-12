// A minimal but anchor-faithful copy of the two bundles dsh-retry patches.
// Keeping the literals here (instead of importing them from lib/patch.js) makes
// the fixture fail loudly when an anchor changes shape, which is the signal that
// the patch strategy needs review rather than a silently green test run.
import { ACCOUNT_ENTRY, MAIN_ENTRY, patchAccount, patchMain } from '../../lib/patch.js';
import { writeAsar } from './write-asar.mjs';

const TRAY_QUIT_ANCHOR =
  '\t\t\t{\n' +
  '\t\t\t\tlabel: messages.quitApplication,\n' +
  '\t\t\t\tclick: () => {\n' +
  '\t\t\t\t\tthis.options.quit();\n' +
  '\t\t\t\t}\n' +
  '\t\t\t}\n' +
  '\t\t]));';

const ACCOUNT_CONTACT_ITEM =
  '\t\t\t\t\t\t\t{\n' +
  '\t\t\t\t\t\t\t\tid: "contact",\n' +
  '\t\t\t\t\t\t\t\tlabel: t("contactUs"),\n' +
  '\t\t\t\t\t\t\t\ticon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPaperPlaneOutlineMedium, { size: 16 })\n' +
  '\t\t\t\t\t\t\t},';

const ACCOUNT_SELECT_ANCHOR =
  '\t\t\t\t\t\t\t} else if (id === "contact") {\n' +
  '\t\t\t\t\t\t\t\tsetOpen(false);\n' +
  '\t\t\t\t\t\t\t\tcontactUs();\n' +
  '\t\t\t\t\t\t\t} else if (id === "signin") beginSignIn();';

/** The tail of applicationItems(): hide group, then quit. */
const APP_MENU_TAIL =
  '\t\t{ type: "separator" },\n' +
  '\t\t...hideCommands,\n' +
  '\t\t{\n' +
  '\t\t\trole: "quit",\n' +
  '\t\t\t...(win32 ? { label: messages.exitApplication } : {})\n' +
  '\t\t}\n' +
  '\t];';

export function pristineMain() {
  return [
    'const en = {',
    '\trestartApplication: "Restart",',
    '};',
    'const zh = {',
    '\trestartApplication: "重启",',
    '};',
    'const menu = Menu.buildFromTemplate([',
    '\t{ label: messages.settings },',
    TRAY_QUIT_ANCHOR,
    '',
    'const applicationItems = () => [',
    '\t{ label: messages.aboutMenu },',
    '\t{ label: messages.checkUpdatesMenu },',
    APP_MENU_TAIL,
    '',
    'let quitting = false;',
  ].join('\n');
}

export function pristineAccount() {
  return [
    'const en = {',
    '\t\t\tsettings: "Settings",',
    '};',
    'const zh = {',
    '\t\t\tsettings: "设置",',
    '};',
    'function renderItems() {',
    '\t\t\treturn [',
    '\t\t\t\t...(0, react_jsx_runtime.jsxs)(Fragment, { children: [',
    ACCOUNT_CONTACT_ITEM,
    '\t\t\t\t] }),',
    '\t\t\t];',
    '}',
    'function onSelect(id) {',
    '\t\t\tif (id === "signin") beginSignIn();',
    ACCOUNT_SELECT_ANCHOR,
    '}',
  ].join('\n');
}

export function bundleFiles({ version = '0.2.1-rc.5', main = pristineMain(), account = pristineAccount() } = {}) {
  return new Map([
    ['package.json', JSON.stringify({ name: 'deepseek-harness-desktop', version })],
    ['index.html', '<html></html>'],
    [MAIN_ENTRY, main],
    [ACCOUNT_ENTRY, account],
  ]);
}

/** Write a pristine (unpatched) archive the plugin can legitimately patch. */
export function writePristineAsar(file, options = {}) {
  writeAsar(file, bundleFiles(options));
  return file;
}

/** Write an archive that already carries the current patch, as the helper leaves it. */
export function writePatchedAsar(file, options = {}) {
  const main = patchMain(options.main ?? pristineMain());
  const account = patchAccount(options.account ?? pristineAccount());
  if (main.missing.length > 0 || account.missing.length > 0) {
    throw new Error(`fixture does not cover every patch anchor: main=${main.missing} account=${account.missing}`);
  }
  writeAsar(file, bundleFiles({ ...options, main: main.text, account: account.text }));
  return file;
}