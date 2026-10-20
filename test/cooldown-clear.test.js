import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Exercise the shipped AccountList without a DOM, React install, or account RPCs.
//
// The regression this pins: a login can carry several cooldown scopes at once
// (the whole account, plus one entry per limited model). The clear buttons used
// to live in the row's action bar, away from the badges, which made two
// model-scoped cooldowns render as two identical "clear this model" buttons —
// with nothing on screen saying which model each one would unbench.
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const component = source.slice(
  source.indexOf('    const zh = {'),
  source.indexOf('    function apply(ctx)'),
);
assert.ok(component.includes('function AccountList'), 'AccountList not found in lib/client.js');

const ROUTE = '/plugins/dsh-workbuddy-switcher/accounts';
const FILE = 'e1abd3c3-0000-4000-8000-000000005247.json';
const ACTIVE_MODEL = 'deepseek-v4.1-flash';
const SECOND_MODEL = 'step-5-preview';
const CLEAR = '解除';
const ACCOUNT_LABEL = '解除冷却：账号额度';
const modelLabel = (model) => `解除该模型冷却：${model}`;
const MODEL_HINT = '只有这个模型被限流，其他模型仍可用这个账号';

/** One cooldown scope as the Host serializes it. */
function scope(model, untilMs, reason = '') {
  return { model, untilMs, reason, strikes: 1 };
}

/**
 * Render AccountList through a minimal React/JSX shim.
 *
 * @param accounts - account rows to render (the Host's `state.accounts` shape).
 * @param options - `selectedFile` and `busy` overrides.
 * @returns the rendered nodes plus a recorder for the `run` action.
 */
function render(accounts, options = {}) {
  const calls = [];
  const hooks = [];
  let cursor = 0;
  const react = {
    Fragment: Symbol.for('react.fragment'),
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = initial;
      return [
        hooks[index],
        (value) => {
          hooks[index] = typeof value === 'function' ? value(hooks[index]) : value;
        },
      ];
    },
    useRef(initial) {
      const index = cursor++;
      return (hooks[index] ??= { current: initial });
    },
    useCallback: (fn) => fn,
    useEffect() {},
    useMemo: (fn) => fn(),
  };
  const jsx = (type, props) => ({ type, props });
  const context = vm.createContext({
    react,
    jsx,
    jsxs: jsx,
    window: { setInterval: () => 0, clearInterval() {} },
    fetch: async () => {
      throw new Error('no network in this test');
    },
    localStorage: { getItem: () => null, setItem() {} },
    document: {},
    URL,
    AbortController,
    Blob,
    console,
  });
  vm.runInContext(
    `${component}\nglobalThis.h = { AccountList, zh, styles };`,
    context,
  );
  const { AccountList, zh, styles } = context.h;
  const view = {
    state: {
      accounts,
      selectedFile: options.selectedFile ?? FILE,
      checkin: { accounts: {} },
      activeModel: ACTIVE_MODEL,
    },
    busy: options.busy,
    error: undefined,
    ok: undefined,
    run: (label, body) => calls.push({ label, body }),
    checkin: () => {},
  };
  cursor = 0;
  const tree = AccountList({ view, compact: false });
  return { tree, calls, zh, styles };
}

/** Depth-first walk over rendered nodes. */
function* walk(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child);
    return;
  }
  if (typeof node === 'string' || typeof node === 'number') return;
  yield node;
  if (node.type === Symbol.for('react.fragment')) {
    yield* walk(node.props?.children);
    return;
  }
  yield* walk(node.props?.children);
}

/** Concatenated text of a subtree. */
function text(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(text).join('');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return text(node.props?.children);
}

/**
 * Plain copy of a recorded `run` body.
 *
 * The component is evaluated in its own `vm` realm, so its object literals do
 * not share this realm's `Object.prototype` and `deepStrictEqual` would reject
 * an otherwise identical payload on the prototype alone.
 */
function payload(call) {
  return JSON.parse(JSON.stringify(call.body));
}

/** Every element with a `data-cooldown` marker, in render order. */
function groups(tree) {
  return [...walk(tree)].filter((node) => node?.props?.['data-cooldown'] !== undefined);
}

/** The action bar: the element whose inline style is `styles.bar`. */
function actionBar(tree, styles) {
  return [...walk(tree)].find((node) => node?.props?.style === styles.bar);
}

/** Buttons inside one rendered subtree. */
function buttonsOf(node) {
  return [...walk(node?.props?.children)].filter((child) => child?.type === 'button');
}

function account(overrides = {}) {
  return {
    file: FILE,
    uid: FILE.replace('.json', ''),
    nickname: '',
    region: 'cn',
    enterpriseId: '',
    refreshExpiresAtMs: Date.now() + 86400000,
    cooldowns: [],
    blocked: true,
    ...overrides,
  };
}

test('each cooldown badge carries the button that clears exactly that scope', () => {
  const until = Date.now() + 3600000;
  const rows = [
    account({
      cooldowns: [
        scope(null, until, 'RATE_LIMIT · credits exhausted'),
        scope(ACTIVE_MODEL, until, 'RATE_LIMIT · model limited'),
        scope(SECOND_MODEL, until, 'RATE_LIMIT · second model limited'),
      ],
    }),
  ];
  const { tree, calls, styles } = render(rows);
  const found = groups(tree);
  assert.equal(found.length, 3, 'one group per live cooldown scope');

  // Same order as the Host serialized them, and each group is exactly
  // [badge, button] with the button inside the group.
  assert.deepEqual(
    found.map((node) => node.props['data-cooldown']),
    ['account', ACTIVE_MODEL, SECOND_MODEL],
  );
  for (const node of found) {
    const children = node.props.children;
    assert.equal(children.length, 2);
    assert.equal(children[0].type, 'span');
    assert.equal(children[1].type, 'button');
    // The group must not be allowed to break between badge and button, and the
    // chip must not shrink away from its badge on a narrow popover.
    assert.equal(node.props.style.display, 'inline-flex');
    assert.equal(node.props.style.flexWrap, 'nowrap');
    assert.equal(children[1].props.style.flex, '0 0 auto');
    // The badge is the part that gives way, so a long id reflows instead of
    // pushing the chip out of the card.
    assert.equal(children[0].props.style.whiteSpace, 'normal');
    assert.equal(children[0].props.style.minWidth, 0);
    // The button label is the compact one; the badge says what it clears.
    assert.equal(text(children[1]), CLEAR);
  }

  const [accountGroup, firstModel, secondModel] = found;
  assert.match(text(accountGroup.props.children[0]), /账号额度/);
  assert.match(text(firstModel.props.children[0]), /deepseek-v4\.1-flash/);
  assert.match(text(secondModel.props.children[0]), /step-5-preview/);

  // Distinct accessible names and tooltips — the visible text alone is shared.
  const labels = found.map((node) => node.props.children[1].props['aria-label']);
  assert.equal(new Set(labels).size, 3, 'every clear button names its own scope');
  assert.equal(labels[0], ACCOUNT_LABEL);
  assert.equal(labels[1], modelLabel(ACTIVE_MODEL));
  assert.equal(labels[2], modelLabel(SECOND_MODEL));
  assert.equal(firstModel.props.children[1].props.title, MODEL_HINT);

  // Clicking a button clears that scope and nothing else.
  for (const node of found) {
    const button = node.props.children[1];
    button.props.onClick();
    const expected = node.props['data-cooldown'];
    const call = calls.at(-1);
    assert.deepEqual(payload(call), {
      action: 'clear-cooldown',
      file: FILE,
      ...(expected === 'account' ? {} : { model: expected }),
    });
    assert.equal(call.label, `clear-cooldown:${FILE}:${expected === 'account' ? '' : expected}`);
  }
  assert.equal(calls.length, 3);

  // Nothing clear-related is left in the shared action bar.
  const bar = actionBar(tree, styles);
  assert.ok(bar !== undefined, 'action bar rendered');
  const barButtons = buttonsOf(bar);
  assert.ok(barButtons.length > 0);
  for (const button of barButtons) {
    assert.doesNotMatch(text(button), /解除/);
    assert.doesNotMatch(String(button.props.title ?? ''), /解除/);
  }
});

test('one cooldown renders one pair, not a button per row action', () => {
  const { tree, styles } = render([
    account({ cooldowns: [scope(ACTIVE_MODEL, Date.now() + 60000)] }),
  ]);
  assert.equal(groups(tree).length, 1);
  const barLabels = buttonsOf(actionBar(tree, styles)).map((node) => text(node));
  // 删除 + 签到, and no switch button because this row is the selected one.
  assert.deepEqual(barLabels, ['删除', '签到']);
});

test('an account-wide cooldown still gets one clear button, and only that', () => {
  const { tree, calls } = render([
    account({ cooldowns: [scope(null, Date.now() + 60000)] }),
  ]);
  const [node] = groups(tree);
  assert.equal(node.props['data-cooldown'], 'account');
  node.props.children[1].props.onClick();
  assert.deepEqual(payload(calls.at(-1)), { action: 'clear-cooldown', file: FILE });
});

test('a cooldown that does not block the routed model keeps its dimmed badge and its button', () => {
  const { tree } = render([
    account({ blocked: false, cooldowns: [scope(SECOND_MODEL, Date.now() + 60000)] }),
  ]);
  const [node] = groups(tree);
  assert.equal(node.props.children[0].props.style.opacity, 0.65);
  assert.equal(node.props.children[1].props.disabled, false);
});

test('while an action is running every clear button is disabled', () => {
  const { tree } = render(
    [
      account({
        cooldowns: [scope(null, Date.now() + 60000), scope(ACTIVE_MODEL, Date.now() + 60000)],
      }),
    ],
    { busy: `clear-cooldown:${FILE}:` },
  );
  // Pin the count first: on the old layout this loop would simply not run and a
  // vacuous pass here is exactly how the "buttons are gone" regression sneaks in.
  const found = groups(tree);
  assert.equal(found.length, 2);
  for (const node of found) {
    assert.equal(node.props.children[1].props.disabled, true);
    assert.equal(node.props.children[1].props.style.opacity, 0.55);
  }
});

test('a cooldown-free account renders no groups and no clear buttons', () => {
  const { tree, styles } = render([account()]);
  assert.equal(groups(tree).length, 0);
  for (const button of buttonsOf(actionBar(tree, styles))) {
    assert.doesNotMatch(text(button), /解除/);
  }
});

test('the component slice still posts to the plugin route', () => {
  // A cheap guard that the slice used above belongs to the shipped client and
  // that the clear action still targets the plugin's own route.
  assert.ok(source.includes(ROUTE));
  assert.ok(component.includes("action: 'clear-cooldown'"));
});
