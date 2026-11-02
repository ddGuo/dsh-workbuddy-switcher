import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

/**
 * The shipped bundle must register under this plugin's id even when the loader
 * already holds something else — measured failure: `client-modules: could not
 * load "dsh-workbuddy-switcher": loaded without registering
 * "dsh-workbuddy-switcher" via __ModuleLoader__.load`.
 *
 * Cause: the bundle used to forward the vendored bridge's
 * `dsh-workbuddy-connect` registration to the loader. The real loader throws on a
 * duplicate id, so a page that already had that id (a leftover standalone
 * package, or an earlier generation of this bundle) aborted the script at its
 * first line — before our own registration ran.
 */

const BUNDLE = readFileSync(new URL('../lib/client.bundle.js', import.meta.url), 'utf8');

/** Evaluate the shipped bundle against a loader that behaves like the real one. */
function load(preloaded = []) {
  const factories = new Map(preloaded.map((id) => [id, () => ({ name: `${id}-stale` })]));
  const attempts = [];
  const loader = {
    mode: 'queue',
    pendingQueue: [],
    load(registration) {
      if (registration === null || typeof registration !== 'object' || typeof registration.id !== 'string') {
        throw new Error('client-modules: registration without an id');
      }
      attempts.push(registration.id);
      // The real loader rejects a second registration by throwing.
      if (factories.has(registration.id)) {
        throw new Error(`client-modules: duplicate factory registration for "${registration.id}"`);
      }
      factories.set(registration.id, registration.factory);
      this.pendingQueue.push(registration);
    },
    create() {
      return {};
    },
  };

  const sandbox = {
    window: { __ModuleLoader__: loader },
    console: { log() {}, warn() {}, error() {}, debug() {} },
    Map, Set, Symbol, Object, Array, JSON, Math, Date, Error, TypeError,
    Promise, RegExp, String, Number, Boolean, isNaN, parseInt, parseFloat,
    setTimeout, clearTimeout,
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox.window;

  let topLevel;
  try {
    vm.runInContext(BUNDLE, vm.createContext(sandbox), { filename: 'client.bundle.js' });
  } catch (error) {
    topLevel = error;
  }
  return { factories, attempts, topLevel, sandbox };
}

test('registers under this plugin id on a clean page', () => {
  const { factories, topLevel } = load();
  assert.equal(topLevel, undefined, 'the bundle must not throw at top level');
  assert.ok(factories.has('dsh-workbuddy-switcher'));
});

test('registers even when the vendored bridge id is already loaded', () => {
  // This is the reported incident: a leftover `dsh-workbuddy-connect` in the
  // factory map used to abort the script before our own id was reached.
  const { factories, topLevel, attempts } = load(['dsh-workbuddy-connect']);
  assert.equal(topLevel, undefined, 'a preloaded bridge id must not break the script');
  assert.ok(factories.has('dsh-workbuddy-switcher'), 'our id must still be registered');
  assert.deepEqual(attempts, ['dsh-workbuddy-switcher'], 'the bridge id is captured, never forwarded');
});

test('registers even when a previous generation already registered this id', () => {
  const { factories, topLevel } = load(['dsh-workbuddy-connect', 'dsh-workbuddy-switcher']);
  assert.equal(topLevel, undefined, 'an in-place upgrade must not throw');
  assert.ok(factories.has('dsh-workbuddy-switcher'));
});

test('the bridge factory is still captured so its UI can be mounted', () => {
  const { sandbox } = load();
  const captured = sandbox.window.__DSH_BUNDLED_BRIDGE_CLIENTS__;
  assert.ok(captured instanceof Map, 'the capture map must exist');
  assert.ok(captured.has('dsh-workbuddy-connect'), 'the vendored bridge factory must be captured');
  assert.equal(typeof captured.get('dsh-workbuddy-connect'), 'function');
});

test('the bridge is captured but never handed to the loader', () => {
  const { attempts } = load();
  // Forwarding it is what made a duplicate throw; the loader has no use for the
  // vendored id because this plugin mounts that UI itself.
  assert.deepEqual(attempts, ['dsh-workbuddy-switcher']);
});

test('a loader that is absent does not make the bundle throw', () => {
  const sandbox = { window: {}, console: { log() {}, error() {}, debug() {} } };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox.window;
  assert.doesNotThrow(() => {
    vm.runInContext(BUNDLE, vm.createContext(sandbox), { filename: 'client.bundle.js' });
  });
});
