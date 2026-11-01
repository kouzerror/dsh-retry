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

function makeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
  };
}

function loadClient({ language = 'zh-CN' } = {}) {
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
  const React = makeReact();
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
      return { ok: true, status: 200, json: async () => ({ patched: true, autoRestart: { limit: 2, guard: null } }) };
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
  return { spec, result, appended, document, fetched };
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
  const english = loadClient({ language: 'en-US' });
  const registered = [];
  english.result.apply({
    slots: {
      inject: (name, register) => register(),
      register: (definition) => registered.push(definition),
    },
  });
  assert.equal(registered[0].label(), 'Restart & updates');
});

test('settings page renders the restart row and the patch status rows', () => {
  const { result } = loadClient();
  const registered = [];
  result.apply({
    slots: {
      inject: (name, register) => register(),
      register: (definition, Component) => registered.push(Component),
    },
  });
  const page = registered[0]({});
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

test('style tag is injected once with a stable plugin key', () => {
  const { result, appended } = loadClient();
  assert.equal(appended.length, 1);
  assert.equal(appended[0].tagName, 'style');
  assert.equal(appended[0].attributes['data-plugin-css'], '@dsh-retry/client');
  assert.match(appended[0].textContent, /\.dsh-retry-primary/);
  // The sidebar icon entry is gone; a regression would reintroduce its CSS.
  assert.doesNotMatch(appended[0].textContent, /\.dsh-retry-action/);
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
