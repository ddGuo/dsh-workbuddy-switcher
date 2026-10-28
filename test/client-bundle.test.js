import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/**
 * The shipped client is one file because DSH loads one client entry per package.
 * It has to keep two things true: the vendored bridge still registers its own
 * module, and this plugin's half mounts that UI rather than silently dropping it.
 */
const bundleSource = readFileSync(new URL('../lib/client.bundle.js', import.meta.url), 'utf8');
const ownSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

/** A loader stub that records registrations, like the real `__ModuleLoader__`. */
function loader() {
  const registered = new Map();
  const window = {
    __ModuleLoader__: {
      load(spec) {
        registered.set(spec.id, spec.factory);
        return spec;
      },
    },
  };
  window.window = window;
  return { window, registered };
}

const minimalRequire = (id) => {
  if (id === 'react') {
    return {
      createElement: () => undefined,
      Fragment: 'fragment',
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
      useRef: (initial) => ({ current: initial }),
      useEffect: () => {},
      useMemo: (build) => build(),
      useCallback: (fn) => fn,
    };
  }
  if (id === 'react/jsx-runtime') return { jsx: () => undefined, jsxs: () => undefined };
  throw new Error(`unexpected require: ${id}`);
};

test('the bundle registers both the bridge module and this plugin', () => {
  const { window, registered } = loader();
  vm.runInNewContext(bundleSource, { window, console, Map, Symbol, JSON, Array, Object, String, Math });
  assert.ok(registered.has('dsh-workbuddy-connect'), 'bridge client module must still register');
  assert.ok(registered.has('dsh-workbuddy-switcher'), 'switcher client module must register');
  // The bridge factory is parked for the switcher half to mount.
  assert.equal(typeof window.__DSH_BUNDLED_BRIDGE_CLIENTS__?.get('dsh-workbuddy-connect'), 'function');
});

test('the switcher half delegates apply to the bundled bridge', () => {
  const { window, registered } = loader();
  const calls = [];
  vm.runInNewContext(ownSource, { window, console, Map, Symbol, JSON, Array, Object, String, Math });

  // Stand in for the bridge factory the assembly step would have parked.
  window.__DSH_BUNDLED_BRIDGE_CLIENTS__ = new Map([
    ['dsh-workbuddy-connect', () => ({
      name: 'bridge-client',
      inject: ['slots', 'conversation'],
      apply: (ctx) => calls.push(ctx),
    })],
  ]);

  const load = registered.get('dsh-workbuddy-switcher');
  const module = load(minimalRequire);
  assert.ok(module.inject.includes('slots'));
  assert.ok(module.inject.includes('conversation'), 'the bridge services must be in inject too');

  const injected = [];
  const ctx = {
    slots: { inject: (name) => injected.push(name), register: () => {} },
    inject: () => {},
  };
  module.apply(ctx);
  assert.deepEqual(calls, [ctx], 'the bridge apply must run with the same context');
  assert.ok(injected.includes('plugins.bundle.config'));
  assert.ok(injected.includes('shell.overlay'));
});

test('a broken bridge half cannot take the switcher UI down', () => {
  const { window, registered } = loader();
  vm.runInNewContext(ownSource, { window, console: { ...console, error: () => {} }, Map, Symbol, JSON, Array, Object, String, Math });
  window.__DSH_BUNDLED_BRIDGE_CLIENTS__ = new Map([
    ['dsh-workbuddy-connect', () => ({ apply: () => { throw new Error('boom'); } })],
  ]);

  const module = registered.get('dsh-workbuddy-switcher')(minimalRequire);
  const injected = [];
  module.apply({
    slots: { inject: (name) => injected.push(name), register: () => {} },
    inject: () => {},
  });
  assert.ok(injected.includes('shell.overlay'), 'the launcher still mounts');
});
