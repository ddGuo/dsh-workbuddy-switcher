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
 * ## Why the bridge's registration must be swallowed, not forwarded
 *
 * The real loader rejects a second registration of one id by **throwing**
 * (`client-modules: duplicate factory registration for "<id>"`). The vendored
 * bridge registers `dsh-workbuddy-connect`, an id that a page can already hold:
 * a leftover copy of the standalone package, or an earlier generation of this
 * bundle whose registration was not invalidated. Forwarding that registration
 * makes the throw happen at the *first* line of our script — before our own
 * `dsh-workbuddy-switcher` registration is reached — and the host then reports
 * the confusing `loaded without registering "dsh-workbuddy-switcher"`.
 *
 * Measured in a loader harness: with `dsh-workbuddy-connect` preloaded, the
 * forwarding version throws on registration and our id never appears; the
 * swallowing version loads and registers normally.
 *
 * The bridge's factory is not lost by swallowing it: it is captured in
 * `window.__DSH_BUNDLED_BRIDGE_CLIENTS__`, which is exactly how this plugin's
 * half mounts that UI. The loader never needs the bridge as a module of its own.
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
  if (loader === undefined || loader === null || typeof loader.load !== "function") return;
  var originalLoad = loader.load.bind(loader);
  var factories = new Map();
  window.__DSH_BUNDLED_BRIDGE_CLIENTS__ = factories;
  // Capture the bridge's factory and DO NOT forward it: forwarding a
  // registration the loader already holds makes it throw, which would abort this
  // script before this plugin's own id is registered.
  loader.load = function loadCaptured(spec) {
    if (spec !== null && typeof spec === "object" && typeof spec.id === "string") {
      factories.set(spec.id, spec.factory);
      return undefined;
    }
    return originalLoad(spec);
  };
  try {
${bridge
  .split('\n')
  .map((line) => (line === '' ? '' : `    ${line}`))
  .join('\n')}
  } catch (error) {
    // One half failing must not take the other down: the switcher UI is still
    // worth mounting without the vendor's settings card.
    if (typeof console !== "undefined" && console.error) {
      console.error("dsh-workbuddy-switcher: bundled WorkBuddy UI failed to register", error);
    }
  } finally {
    loader.load = originalLoad;
  }
})();
`;

writeFileSync(new URL('lib/client.bundle.js', root), `${header}\n${wrapper}\n${own}`, 'utf8');
console.log('wrote lib/client.bundle.js');

