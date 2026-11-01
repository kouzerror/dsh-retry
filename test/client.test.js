/* Static harness for lib/client.js: it is a plain browser bundle that calls
 * window.__ModuleLoader__.load, so the test evaluates it in a VM context with
 * stubbed DOM, navigator and react, then drives the captured factory directly. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8');

/** Minimal hook runtime: enough React to mount the settings page and let
 * state updates from async fetch handlers rerender it. Nested components stay
 * plain elements, so tests inspect the element tree directly. */
function makeRuntime() {
  let instance = null;
  let hookIndex = 0;

  const createElement = (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } });

  const render = () => {
    const inst = instance;
    inst.rendering = true;
    inst.dirty = false;
    inst.pendingEffects = [];
    hookIndex = 0;
    inst.tree = inst.Component(inst.props);
    inst.rendering = false;
    return inst.tree;
  };

  const runEffects = () => {
    const inst = instance;
    const effects = inst.pendingEffects;
    inst.pendingEffects = [];
    for (const effect of effects) effect();
  };

  const flush = () => {
    const inst = instance;
    let guard = 0;
    while (inst !== null && inst.dirty && guard < 100) {
      guard += 1;
      render();
      runEffects();
    }
    return inst?.tree;
  };

  const React = {
    createElement,
    useState(initial) {
      if (instance === null) return [typeof initial === 'function' ? initial() : initial, () => {}];
      const inst = instance;
      const slot = hookIndex++;
      if (!inst.hooks.has(slot)) inst.hooks.set(slot, typeof initial === 'function' ? initial() : initial);
      const setState = (next) => {
        const value = typeof next === 'function' ? next(inst.hooks.get(slot)) : next;
        if (Object.is(value, inst.hooks.get(slot))) return;
        inst.hooks.set(slot, value);
        inst.dirty = true;
        if (!inst.rendering) flush();
      };
      return [inst.hooks.get(slot), setState];
    },
    useEffect(effect, deps) {
      if (instance === null) return;
      const inst = instance;
      const slot = hookIndex++;
      const previous = inst.effects.get(slot);
      const nextDeps = deps ?? null;
      const changed =
        previous === undefined ||
        nextDeps === null ||
        previous.deps === null ||
        previous.deps.length !== nextDeps.length ||
        nextDeps.some((value, index) => !Object.is(value, previous.deps[index]));
      if (!changed) return;
      inst.effects.set(slot, { deps: nextDeps });
      inst.pendingEffects.push(effect);
    },
  };

  const mount = (Component, props) => {
    instance = {
      Component,
      props,
      hooks: new Map(),
      effects: new Map(),
      pendingEffects: [],
      dirty: false,
      rendering: false,
      tree: null,
    };
    render();
    runEffects();
    flush();
    return {
      get tree() {
        return instance.tree;
      },
      flush,
    };
  };

  return { React, mount };
}

const STATUS_PAYLOAD = { patched: true, plugin: { version: '0.5.1' }, autoRestart: { limit: 2, guard: null } };

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const defaultFetch = async (url) => {
  if (url === '/dsh-retry/status') return jsonResponse(200, STATUS_PAYLOAD);
  if (url === '/dsh-retry/update') return jsonResponse(200, { ok: true, updateAvailable: false });
  return jsonResponse(200, { ok: true });
};

function loadClient({ language = 'zh-CN', fetch: customFetch } = {}) {
  const appended = [];
  const document = {
    documentElement: { lang: language },
    head: {
      appendChild(node) {
        appended.push(node);
      },
    },
    querySelector: (selector) => appended.find((node) => selector.includes(node.attributes['data-plugin-css'] ?? '\u0000')) ?? null,
    createElement: (tagName) => ({
      tagName,
      attributes: {},
      textContent: '',
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
    }),
  };
  const runtime = makeRuntime();
  const React = runtime.React;
  const fetched = [];
  let spec = null;
  const context = {
    window: {
      __ModuleLoader__: {
        load(next) {
          spec = next;
        },
      },
    },
    document,
    navigator: { language },
    fetch: async (url, init = {}) => {
      fetched.push({ url, init });
      return (customFetch ?? defaultFetch)(url, init);
    },
    console,
  };
  context.globalThis = context;
  vm.runInNewContext(SOURCE, context, { filename: 'lib/client.js' });
  assert.ok(spec, 'client bundle must call window.__ModuleLoader__.load');
  const require = (id) => {
    assert.equal(id, 'react');
    return React;
  };
  const result = spec.factory(require);
  return { spec, result, appended, document, fetched, mount: runtime.mount };
}

function openSettings(options = {}) {
  const client = loadClient(options);
  const registered = [];
  client.result.apply({
    slots: {
      inject: (name, register) => register(),
      register: (definition, Component) => registered.push({ definition, Component }),
    },
  });
  assert.equal(registered.length, 1, 'the settings page must stay the only registered slot');
  return { client, definition: registered[0].definition, Component: registered[0].Component };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function settle(rounds = 6) {
  for (let index = 0; index < rounds; index += 1) await tick();
}

function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  visit(node);
  walk(node.props?.children, visit);
}

const classList = (node) => (typeof node?.props?.className === 'string' ? node.props.className.split(/\s+/).filter(Boolean) : []);

function byClass(tree, name) {
  const found = [];
  walk(tree, (node) => {
    if (classList(node).includes(name)) found.push(node);
  });
  return found;
}

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node === null || node === undefined || typeof node !== 'object') return '';
  return textOf(node.props?.children);
}

const text = (tree) => textOf(tree);

/** StatusRows is left as a plain element (the harness never invokes nested
 * components), so its `rows` prop is the rendered key/value contract. The
 * update card is the last such element in the page. */
function lastStatusRows(tree) {
  const groups = [];
  walk(tree, (node) => {
    if (Array.isArray(node?.props?.rows)) groups.push(node.props.rows);
  });
  return groups.length === 0 ? [] : groups[groups.length - 1];
}

function statusRow(tree, label) {
  const row = lastStatusRows(tree).find((entry) => entry[0] === label);
  return row === undefined ? null : { value: row[1], tone: row[2], extra: row[3] };
}

test('client bundle registers under the dsh-retry module id', () => {
  const { spec } = loadClient();
  assert.equal(spec.id, 'dsh-retry');
  assert.equal(typeof spec.factory, 'function');
});

test('factory returns the slots injection and a callable apply', () => {
  const { result } = loadClient();
  assert.deepEqual([...result.inject], ['slots']);
  assert.equal(typeof result.apply, 'function');
});

test('apply registers the settings page only', () => {
  const { result } = loadClient();
  const injected = [];
  const registered = [];
  const ctx = {
    slots: {
      inject(name, register) {
        injected.push(name);
        register();
      },
      register(definition, Component) {
        registered.push({ definition, Component });
        return definition.id;
      },
    },
  };
  result.apply(ctx);
  assert.deepEqual(injected, ['settings.section']);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].definition.name, 'settings.section');
  assert.equal(registered[0].definition.id, 'dsh-retry');
  assert.equal(registered[0].definition.order, 95);
  assert.equal(registered[0].definition.label(), '重启与更新');
  assert.equal(typeof registered[0].Component, 'function');
});

test('slot labels follow the renderer language', () => {
  const { definition } = openSettings({ language: 'en-US' });
  assert.equal(definition.label(), 'Restart & updates');
});

test('settings page renders the restart row and the patch status rows', () => {
  const { Component } = openSettings();
  const page = Component({});
  assert.equal(page.type, 'div');
  assert.equal(page.props.className, 'dsh-retry-page');
  const [restartCard, statusCard] = page.props.children;
  const restartButton = restartCard.props.children[0].props.children[1];
  assert.equal(restartButton.type, 'button');
  assert.equal(restartButton.props.className, 'dsh-retry-primary');
  assert.deepEqual(restartButton.props.children, ['重启']);
  const statusRows = statusCard.props.children[2];
  assert.ok(statusRows, 'status rows must render once a status payload exists');
});

test('update card is rendered but does not check on mount', async () => {
  const { client, Component } = openSettings();
  const mounted = client.mount(Component, {});
  await settle();
  const tree = mounted.tree;
  const pageText = text(tree);
  assert.match(pageText, /插件更新/);
  assert.equal(statusRow(tree, '当前版本').value, '0.5.1', 'the status payload supplies the fallback version');
  assert.equal(statusRow(tree, '最新版本').value, '—');
  assert.equal(statusRow(tree, '状态').value, '尚未检查');
  assert.equal(statusRow(tree, '状态').tone, 'muted', 'an unchecked card stays visually secondary');
  assert.equal(statusRow(tree, '状态').extra, 'dsh-retry-update-state');
  assert.equal(byClass(tree, 'dsh-retry-update-check').length, 1);
  assert.equal(byClass(tree, 'dsh-retry-update-install').length, 0, 'no install button before a check');
  assert.equal(
    client.fetched.filter((call) => call.url === '/dsh-retry/update').length,
    0,
    'mounting the settings page must not hit the update API',
  );
});

test('checking shows the install button and installing offers a restart', async () => {
  const replies = {
    updateGet: jsonResponse(200, { ok: true, updateAvailable: true, current: { version: '0.5.1' }, latest: { version: '9.9.9' } }),
    updatePost: jsonResponse(200, { ok: true, installed: { from: '0.5.1', to: '9.9.9' }, restartRequired: true }),
    restart: jsonResponse(200, { ok: true }),
  };
  const { client, Component } = openSettings({
    fetch: async (url, init = {}) => {
      if (url === '/dsh-retry/update') return init.method === 'POST' ? replies.updatePost : replies.updateGet;
      if (url === '/dsh-retry/restart') return replies.restart;
      return jsonResponse(200, STATUS_PAYLOAD);
    },
  });
  const mounted = client.mount(Component, {});
  await settle();

  byClass(mounted.tree, 'dsh-retry-update-check')[0].props.onClick();
  await settle();
  assert.equal(byClass(mounted.tree, 'dsh-retry-update-install').length, 1);
  assert.equal(statusRow(mounted.tree, '最新版本').value, '9.9.9');
  assert.equal(statusRow(mounted.tree, '状态').value, '发现新版本 v9.9.9');
  assert.equal(statusRow(mounted.tree, '状态').tone, 'warn');

  byClass(mounted.tree, 'dsh-retry-update-install')[0].props.onClick();
  await settle();
  assert.equal(byClass(mounted.tree, 'dsh-retry-update-install').length, 0);
  assert.equal(byClass(mounted.tree, 'dsh-retry-update-restart').length, 1);
  assert.equal(statusRow(mounted.tree, '状态').value, '已安装 v9.9.9，重启 DSH 生效');

  // The restart route refuses while the self-update needs a full quit.
  replies.restart = jsonResponse(409, { ok: false, error: 'update_pending' });
  byClass(mounted.tree, 'dsh-retry-update-restart')[0].props.onClick();
  await settle();
  assert.match(text(mounted.tree), /更新已安装，请退出并重新打开 DSH 生效/);
  assert.equal(byClass(mounted.tree, 'dsh-retry-update-restart').length, 0, 'a pending update must not invite another restart');
  assert.ok(client.fetched.some((call) => call.url === '/dsh-retry/restart' && call.init.method === 'POST'));
});

test('a busy host keeps the install button and explains the conflict', async () => {
  const { client, Component } = openSettings({
    fetch: async (url, init = {}) => {
      if (url === '/dsh-retry/update' && init.method === 'POST') return jsonResponse(409, { ok: false, error: 'update_in_progress' });
      if (url === '/dsh-retry/update') return jsonResponse(200, { ok: true, updateAvailable: true, latest: { version: '9.9.9' } });
      return jsonResponse(200, STATUS_PAYLOAD);
    },
  });
  const mounted = client.mount(Component, {});
  await settle();
  byClass(mounted.tree, 'dsh-retry-update-check')[0].props.onClick();
  await settle();
  byClass(mounted.tree, 'dsh-retry-update-install')[0].props.onClick();
  await settle();
  assert.equal(statusRow(mounted.tree, '状态').value, '安装失败：正在更新，请稍候。');
  assert.equal(byClass(mounted.tree, 'dsh-retry-update-install').length, 1, 'a busy host is retryable, so the button stays');
  assert.equal(byClass(mounted.tree, 'dsh-retry-update-restart').length, 0);
});

test('a failed check reports the error instead of throwing', async () => {
  const { client, Component } = openSettings({
    fetch: async (url) => {
      if (url === '/dsh-retry/update') throw new Error('offline');
      return jsonResponse(200, STATUS_PAYLOAD);
    },
  });
  const mounted = client.mount(Component, {});
  await settle();
  byClass(mounted.tree, 'dsh-retry-update-check')[0].props.onClick();
  await settle();
  assert.equal(statusRow(mounted.tree, '状态').value, '检查失败：offline');
  assert.equal(statusRow(mounted.tree, '状态').tone, 'warn');
  assert.equal(byClass(mounted.tree, 'dsh-retry-update-install').length, 0);
  assert.equal(byClass(mounted.tree, 'dsh-retry-update-check').length, 1);
});

test('update card follows the renderer language', () => {
  const { Component } = openSettings({ language: 'en-US' });
  const pageText = text(Component({}));
  assert.match(pageText, /Plugin update/);
  assert.match(pageText, /Check for updates/);
  const rows = lastStatusRows(Component({}));
  assert.equal(rows[0][0], 'Current version');
  assert.equal(rows[1][0], 'Latest version');
  assert.equal(rows[2][0], 'Status');
  assert.equal(rows[2][1], 'Not checked yet');
});

test('style tag is injected once with a stable plugin key', () => {
  const { result, appended } = loadClient();
  assert.equal(appended.length, 1);
  assert.equal(appended[0].tagName, 'style');
  assert.equal(appended[0].attributes['data-plugin-css'], '@dsh-retry/client');
  assert.match(appended[0].textContent, /\.dsh-retry-primary/);
  assert.match(appended[0].textContent, /\.dsh-retry-actions\{/);
  // The sidebar icon entry is gone; a regression would reintroduce its CSS
  // (``.dsh-retry-actions`` is the update card's button row and is expected).
  assert.doesNotMatch(appended[0].textContent, /\.dsh-retry-action(?!s)/);
  // Regression test for the invisible white box: the primary button must use
  // the inverted label token so it stays readable in both themes.
  assert.match(appended[0].textContent, /\.dsh-retry-primary\{[^}]*--dsw-alias-label-primary-inverted/);

  // Re-evaluating the bundle must not append a second copy.
  const again = loadClient();
  assert.equal(again.appended.length, 1);
  assert.equal(typeof result.apply, 'function');
});

test('failure reasons map to actionable messages', () => {
  const { result } = loadClient();
  const { describeFailure } = result.__internals;
  assert.match(describeFailure('restart_in_progress'), /进行中/);
  assert.match(describeFailure('resources_not_writable'), /权限/);
  assert.match(describeFailure('nothing_to_install'), /restart\.log/);
  assert.match(describeFailure('foreign_patch_detected'), /其它插件/);
  assert.match(describeFailure('something_else'), /something_else/);
});

test('update failure reasons map to actionable messages', () => {
  const { result } = loadClient();
  const { describeFailure } = result.__internals;
  assert.match(describeFailure('update_in_progress'), /正在更新/);
  assert.match(describeFailure('update_pending'), /退出并重新打开/);
  assert.match(describeFailure('update_failed'), /restart\.log/);
  assert.match(describeFailure('not_desktop'), /Windows/);
});

test('nextUpdateState maps every host answer to card state', () => {
  const { result } = loadClient();
  const { nextUpdateState } = result.__internals;
  const info = { updateAvailable: true, latest: { version: '9.9.9' } };

  const installed = nextUpdateState(info, {
    status: 200,
    body: { ok: true, installed: { from: '0.5.1', to: '9.9.9' }, restartRequired: true },
  });
  assert.equal(installed.installedVersion, '9.9.9');
  assert.equal(installed.info.updateAvailable, false);
  assert.equal(installed.error, '');

  const upToDate = nextUpdateState(info, { status: 200, body: { ok: true, updateAvailable: false } });
  assert.equal(upToDate.installedVersion, '');
  assert.equal(upToDate.info.updateAvailable, false);
  assert.equal(upToDate.error, '');

  const busy = nextUpdateState(info, { status: 409, body: { ok: false, error: 'update_in_progress' } });
  assert.match(busy.error, /正在更新/);
  assert.equal(busy.info, info, 'a failed install keeps the current check result');

  const failed = nextUpdateState(info, { status: 502, body: { ok: false, error: 'update_failed', detail: 'sha256 mismatch' } });
  assert.match(failed.error, /restart\.log/);
  assert.match(failed.error, /sha256 mismatch/);
});

test('updateStatus covers unchecked, available, installed and failure states', () => {
  const { result } = loadClient();
  const { updateStatus } = result.__internals;
  // Objects cross the VM realm boundary, so compare their fields.
  const state = (input) => {
    const { text: line, tone } = updateStatus(input);
    return { text: line, tone };
  };
  assert.deepEqual(state({ info: null, error: '', errorPhase: '', installedVersion: '' }), { text: '尚未检查', tone: 'muted' });
  assert.deepEqual(state({ info: { updateAvailable: true, latest: { version: '9.9.9' } }, error: '', errorPhase: '', installedVersion: '' }), {
    text: '发现新版本 v9.9.9',
    tone: 'warn',
  });
  assert.deepEqual(state({ info: { updateAvailable: false }, error: '', errorPhase: '', installedVersion: '' }), { text: '已是最新', tone: 'ok' });
  assert.deepEqual(state({ info: null, error: '', errorPhase: '', installedVersion: '9.9.9' }), {
    text: '已安装 v9.9.9，重启 DSH 生效',
    tone: 'warn',
  });
  assert.deepEqual(state({ info: null, error: 'offline', errorPhase: 'check', installedVersion: '' }), {
    text: '检查失败：offline',
    tone: 'warn',
  });
});

test('package manifest declares the client half the loader looks for', () => {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.dsh?.client?.platform, 'web');
  assert.equal(manifest.dsh?.client?.inject, undefined, 'client only requires react, so no inject list');
  const entry = manifest.exports?.['./client'];
  assert.equal(entry?.default, './lib/client.js', 'client-modules resolves exports["./client"] to a relative path');
  assert.ok(existsSync(path.join(ROOT, 'lib', 'client.js')), 'declared client bundle must exist');
});
test('foreign patch is surfaced and can be overridden explicitly', () => {
  assert.match(SOURCE, /foreign_patch_detected/);
  assert.match(SOURCE, /仍然覆盖并重启/);
  assert.match(SOURCE, /force=1/);
  assert.match(SOURCE, /foreignPatch\?\.detected/);
  assert.match(SOURCE, /其它插件补丁/);
});

test('update wiring targets the documented host routes', () => {
  assert.match(SOURCE, /\/dsh-retry\/update/);
  assert.match(SOURCE, /update_pending/);
  assert.match(SOURCE, /update_failed/);
  assert.match(SOURCE, /sha256/);
  assert.match(SOURCE, /dsh-retry-update-check/);
  assert.match(SOURCE, /dsh-retry-update-install/);
  assert.match(SOURCE, /dsh-retry-update-restart/);
  assert.match(SOURCE, /dsh-retry-update-state/);
});