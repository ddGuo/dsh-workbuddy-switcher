/**
 * Assemble `lib/client.bundle.js`: the vendored WorkBuddy bridge's client bundle
 * followed by this plugin's own.
 *
 * DSH loads exactly one client entry per package (`exports["./client"]`), so a
 * merged plugin has to hand it one file. The bridge's bundle is a
 * self-registering `window.__ModuleLoader__.load({ id, factory })` call, and this
 * plugin's half needs the module object that factory builds. The wrapper below
 * therefore records every factory the bridge registers, then restores the loader
 * before this plugin's own bundle runs — so the two halves stay independent and
 * the bridge's registration is still delivered to the loader as it expects.
 *
 * The output is committed because installs come from git with no build step;
 * re-run `npm run build:client` after editing either half.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const bridge = readFileSync(new URL('lib/bridge/client.js', root), 'utf8');
const own = readFileSync(new URL('lib/client.js', root), 'utf8');

const header = `/**
 * GENERATED FILE — do not edit.
 *
 * Assembled by scripts/build-client.mjs from lib/bridge/client.js (vendored
 * dsh-workbuddy-connect@0.7.8, MIT) followed by lib/client.js. Edit those, then
 * run \`npm run build:client\`.
 */
`;

const wrapper = `(function mountBundledBridgeClient() {
  var loader = window.__ModuleLoader__;
  var originalLoad = loader.load.bind(loader);
  var factories = new Map();
  window.__DSH_BUNDLED_BRIDGE_CLIENTS__ = factories;
  loader.load = function loadCaptured(spec) {
    if (spec !== null && typeof spec === 'object' && typeof spec.id === 'string') {
      factories.set(spec.id, spec.factory);
    }
    return originalLoad(spec);
  };
  try {
${bridge
  .split('\n')
  .map((line) => (line === '' ? '' : `    ${line}`))
  .join('\n')}
  } finally {
    loader.load = originalLoad;
  }
})();
`;

writeFileSync(new URL('lib/client.bundle.js', root), `${header}\n${wrapper}\n${own}`, 'utf8');
console.log('wrote lib/client.bundle.js');
