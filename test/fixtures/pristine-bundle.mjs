// Fixtures that mirror the bundles dsh-retry patches, kept faithful to the
// shapes shipped today: main.js is tab-indented source, while the settings
// account client is a minified ESM bundle with backtick strings. A fixture that
// no longer matches the real build is what makes these tests meaningful.
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
    'let quitting = false;',
  ].join('\n');
}

/** Minified client bundle, as DSH 0.2.2 ships it. */
export function pristineAccount() {
  return [
    'const en={settings:`Settings`,contactUs:`Feedback`,menu:`Account menu`};',
    'const zh={settings:`设置`,contactUs:`意见反馈`,menu:`账号菜单`};',
    'const es={settings:`Configuración`,contactUs:`Comentarios`,menu:`Menú de cuenta`};',
    'const fr={settings:`Paramètres`,contactUs:`Commentaires`,menu:`Menu du compte`};',
    'const de={settings:`Einstellungen`,contactUs:`Rückmeldung`,menu:`Kontomenü`};',
    'const ru={settings:`Настройки`,contactUs:`Обратная связь`,menu:`Меню аккаунта`};',
    'const pt={settings:`Configurações`,contactUs:`Comentários`,menu:`Menu da conta`};',
    'const items=[{id:`settings`,label:t(`settings`),icon:(0,react_jsx_runtime.jsx)' +
      '(_deepseek_ai_dsh_client_ui_primitives.IconSettingsOutlineMedium,{size:16})},' +
      '{id:`contact`,label:t(`contactUs`),icon:(0,react_jsx_runtime.jsx)' +
      '(_deepseek_ai_dsh_client_ui_primitives.IconPaperPlaneOutlineMedium,{size:16})},' +
      '...signedIn?[]:[]];',
    'const onSelect=id=>{if(id===`settings`){setOpen(false);openSettings()}' +
      'else if(id===`contact`){setOpen(false);contactUs()}' +
      'else if(id===`signin`)beginSignIn();else requestSignOut()};',
  ].join('\n');
}

/** Pretty-printed client bundle, as every DSH release before 0.2.2 shipped it. */
export function legacyAccount() {
  return [
    'const en = {',
    '\t\t\tsettings: "Settings",',
    '\t\t\tcontactUs: "Feedback",',
    '};',
    'const zh = {',
    '\t\t\tsettings: "设置",',
    '\t\t\tcontactUs: "意见反馈",',
    '};',
    'function renderItems() {',
    '\t\t\treturn [',
    '\t\t\t\t...(0, react_jsx_runtime.jsxs)(Fragment, { children: [',
    '\t\t\t\t\t{',
    '\t\t\t\t\t\tid: "contact",',
    '\t\t\t\t\t\tlabel: t("contactUs"),',
    '\t\t\t\t\t\ticon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPaperPlaneOutlineMedium, { size: 16 })',
    '\t\t\t\t\t},',
    '\t\t\t\t] }),',
    '\t\t\t];',
    '}',
    'function onSelect(id) {',
    '\t\t\tif (id === "settings") {',
    '\t\t\t\tsetOpen(false);',
    '\t\t\t\topenSettings();',
    '\t\t\t} else if (id === "contact") {',
    '\t\t\t\tsetOpen(false);',
    '\t\t\t\tcontactUs();',
    '\t\t\t} else if (id === "signin") beginSignIn();',
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