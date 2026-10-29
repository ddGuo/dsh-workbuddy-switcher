import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * The update reminder used to check the standalone `dsh-workbuddy-connect`
 * package, which 0.3.0 merged into this one. Against the live registry that
 * produced a false positive — `0.7.9` "latest" versus a `0.7.8` baseline — whose
 * accept button would reinstall the removed package and register a second
 * `workbuddy` provider.
 *
 * These assertions are structural rather than behavioural: the check itself runs
 * in the host with a fetch implementation, so what must be pinned here is that
 * every target names *this* package and that the baseline comes from the
 * manifest instead of a stale constant.
 */

const INDEX = readFileSync(new URL('../lib/bridge/index.js', import.meta.url), 'utf8');
const CLIENT = readFileSync(new URL('../lib/bridge/client.js', import.meta.url), 'utf8');
const BUNDLE = readFileSync(new URL('../lib/client.bundle.js', import.meta.url), 'utf8');
const MANIFEST = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('the update check queries this package, not the merged-away one', () => {
  const match = /WORKBUDDY_UPDATE_NPM_METADATA_URL\s*=\s*`([^`]+)`/u.exec(INDEX);
  assert.ok(match, 'the metadata URL constant should exist');
  assert.equal(
    match[1],
    'https://registry.npmjs.org/-/package/dsh-workbuddy-switcher/dist-tags',
  );
});

test('the release enrichment points at this repository', () => {
  const match = /WORKBUDDY_REPOSITORY_URL\s*=\s*"([^"]+)"/u.exec(INDEX);
  assert.ok(match);
  assert.equal(match[1], 'https://github.com/ddGuo/dsh-workbuddy-switcher');

  // The browser half builds the release page link from its own copy.
  const clientMatch = /WORKBUDDY_REPOSITORY_URL\s*=\s*"([^"]+)"/u.exec(CLIENT);
  assert.ok(clientMatch);
  assert.equal(clientMatch[1], 'https://github.com/ddGuo/dsh-workbuddy-switcher');
});

test('the compared baseline is this plugin manifest, not the vendored bridge version', () => {
  // `pluginVersion()` walks up to the manifest whose name matches, so a hoisted
  // layout cannot hand back a neighbour's version.
  assert.match(INDEX, /manifest\.name === "dsh-workbuddy-switcher"/u);
  assert.match(INDEX, /function pluginVersion\(\)/u);
  // The registration passes that value, with the old constant only as a fallback
  // for the case where no manifest can be read at all.
  assert.match(
    INDEX,
    /registerWorkBuddyUpdateRoute\(webCtx, \{ currentVersion: pluginVersion\(\) \?\? WORKBUDDY_CONNECT_VERSION \}\)/u,
  );
});

test('the manifest version is a parseable SemVer the checker accepts', () => {
  assert.match(MANIFEST.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
});

test('both locales name this plugin in the reminder', () => {
  const labels = [...CLIENT.matchAll(/updateNoticeLabel: "([^"]*)"/gu)].map((m) => m[1]);
  assert.equal(labels.length, 2, 'one English and one Chinese label');
  assert.ok(labels.includes('DSH WorkBuddy Switcher update'));
  assert.ok(labels.includes('DSH WorkBuddy Switcher \u66f4\u65b0'));
  // And the shipped bundle carries the same two, so the rebuild is not stale.
  for (const label of labels) assert.ok(BUNDLE.includes(label), `bundle is missing: ${label}`);
});

test('the recovery prompt names the package a user can actually install', () => {
  // A prompt telling the user to reinstall the merged-away package would fail at
  // the registry, or worse, resurrect the duplicate provider. The string is
  // compared by containment rather than by a quoted literal, because it embeds
  // escaped quotes of its own.
  const start = CLIENT.indexOf('agentUpgradePrompt: "Please open');
  assert.ok(start !== -1, 'the English prompt should exist');
  const english = CLIENT.slice(start, start + 400);
  assert.ok(english.includes('dsh-workbuddy-switcher'), 'should name this package');
  assert.ok(!english.includes('dsh-workbuddy-connect'), 'should not name the merged-away package');

  // Chinese prompt: assert on the ASCII package name inside a Chinese frame.
  assert.match(CLIENT, /\u628a\u63d2\u4ef6 dsh-workbuddy-switcher \u5b89\u88c5\u6216\u66f4\u65b0/u);
});

test('served HTTP route paths keep their historical spelling', () => {
  // These are wire paths the host and browser agree on. Renaming them would
  // break a running pair across an upgrade, so they deliberately still say
  // dsh-workbuddy-connect even though the package is now dsh-workbuddy-switcher.
  assert.match(CLIENT, /WORKBUDDY_UPDATE_PATH = "\/plugins\/dsh-workbuddy-connect\/update"/u);
  assert.match(INDEX, /WORKBUDDY_UPDATE_PATH/u);
});
