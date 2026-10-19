import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Exercise the shipped component without a DOM, React install, or account RPCs.
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const component = source.slice(source.indexOf('    function SwitcherFab()'), source.indexOf('    function apply(ctx)'));
function harness(saved = null, blocked = false) {
  const hooks = [];
  let cursor = 0;
  let effects = [];
  let dirty = false;
  let tree;
  let observer;
  const listeners = new Map();
  const storage = new Map([['dsh-workbuddy-switcher:fab-position', saved]]);
  const button = { getBoundingClientRect: () => ({ width: 180, height: 36 }), setPointerCapture() {} };
  const react = {
    Fragment: 'fragment',
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks[index], (value) => {
        const next = typeof value === 'function' ? value(hooks[index]) : value;
        if (JSON.stringify(next) !== JSON.stringify(hooks[index])) dirty = true;
        hooks[index] = next;
      }];
    },
    useRef(initial) {
      const index = cursor++;
      return hooks[index] ??= { current: initial };
    },
    useEffect(effect, deps) {
      const index = cursor++;
      if (!hooks[index] || deps.some((value, i) => value !== hooks[index][i])) effects.push(effect);
      hooks[index] = deps;
    },
  };
  const window = {
    innerWidth: 1000, innerHeight: 800,
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
  };
  const jsx = (type, props) => {
    if (props.ref) props.ref.current = button;
    return { type, props };
  };
  const context = vm.createContext({
    react, window, jsx, jsxs: jsx,
    localStorage: {
      getItem(key) { if (blocked) throw Error('blocked'); return storage.get(key); },
      setItem(key, value) { if (blocked) throw Error('blocked'); storage.set(key, value); },
    },
    ResizeObserver: class { constructor(fn) { observer = fn; } observe() {} disconnect() {} },
    useAccounts: () => ({ state: undefined }),
    styles: { fab: {}, panel: {}, overlay: {} }, zh: { noActive: 'follow', fabLabel: 'switch' },
    labelOf: () => '', Footer() {}, AccountList() {},
  });
  vm.runInContext(`${component}\nglobalThis.Component = SwitcherFab;`, context);
  function render() {
    do {
      dirty = false;
      cursor = 0;
      effects = [];
      tree = context.Component();
      effects.forEach((effect) => effect());
    } while (dirty);
    return tree.props.children[0].props;
  }
  function event(name, overrides = {}) {
    render()[name]({ pointerId: 1, isPrimary: true, button: 0, clientX: 500, clientY: 500, currentTarget: button, detail: 1, ...overrides });
    return render();
  }
  render();
  return { render, event, storage, window, panel: () => tree.props.children[1]?.props,
    resize(width, height) { window.innerWidth = width; window.innerHeight = height; listeners.get('resize')(); render(); },
    observer: () => { observer(); render(); } };
}

test('click, small jitter, and keyboard retain normal toggle behavior', () => {
  const h = harness();
  h.event('onPointerDown');
  h.event('onPointerMove', { clientX: 502 });
  h.event('onPointerUp');
  assert.equal(h.event('onClick')['aria-expanded'], true);
  assert.equal(h.event('onClick', { detail: 0 })['aria-expanded'], false);
});

test('drag persists position and suppresses only its pointer click', () => {
  const h = harness();
  const before = h.storage.get('dsh-workbuddy-switcher:fab-position');
  h.event('onPointerDown');
  h.event('onPointerMove', { clientX: 300, clientY: 400 });
  assert.equal(h.storage.get('dsh-workbuddy-switcher:fab-position'), before);
  h.event('onPointerUp');
  assert.equal(h.render().style.right, 220);
  assert.equal(h.render().style.bottom, 116);
  assert.equal(h.event('onClick')['aria-expanded'], false);
  const saved = h.storage.get('dsh-workbuddy-switcher:fab-position');
  assert.equal(harness(saved).render().style.right, 220);
  assert.equal(h.event('onClick', { detail: 0 })['aria-expanded'], true);
});

test('viewport edges, resize, and size changes keep launcher and panel accessible', () => {
  const h = harness(JSON.stringify({ right: 9999, bottom: 9999 }));
  assert.equal(h.render().style.right, 812);
  assert.equal(h.render().style.bottom, 756);
  h.resize(320, 480);
  h.observer();
  assert.equal(h.render().style.right, 132);
  assert.equal(h.render().style.bottom, 436);
  h.event('onClick');
  assert.equal(h.panel().style.top, 52);
  assert.equal(h.panel().style.right, 20);
  assert.equal(h.panel().style.maxHeight, 420);
});

test('invalid or blocked storage does not prevent rendering and dragging', () => {
  for (const saved of ['bad JSON', 'null', '{"right":"20","bottom":3}']) {
    assert.equal(harness(saved).render().style.right, 20);
  }
  const h = harness(null, true);
  h.event('onPointerDown');
  h.event('onPointerMove', { clientX: -9999, clientY: -9999 });
  h.event('onPointerCancel');
  assert.equal(h.render().style.right, 812);
  h.event('onPointerDown');
  h.event('onPointerUp');
  assert.equal(h.event('onClick')['aria-expanded'], true);
});

test('secondary pointers and non-primary buttons do not move launcher', () => {
  const h = harness();
  h.event('onPointerDown', { isPrimary: false });
  h.event('onPointerMove', { clientX: 0 });
  assert.equal(h.render().style.right, 20);
  h.event('onPointerDown', { button: 2 });
  h.event('onPointerMove', { clientX: 0 });
  assert.equal(h.render().style.right, 20);
  h.event('onPointerDown');
  h.event('onPointerMove', { pointerId: 2, clientX: 0 });
  assert.equal(h.render().style.right, 20);
});
