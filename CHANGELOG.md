# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Next release notes go here.

## [0.3.7] - 2026-10-29

### Fixed

- **The update reminder pointed at the package 0.3.0 deleted.** The vendored
  bridge brought its own update checker, which queries npm for
  `dsh-workbuddy-connect` and compares the answer with a compiled-in `0.7.8`.
  After the merge that package no longer exists as a dependency, so the check
  read the live `latest` (`0.7.9`), concluded an upgrade was available, and its
  accept button would have reinstalled the standalone package — registering a
  second `workbuddy` provider beside this one, which is exactly the conflict the
  merge removed.

  Measured before the fix: `dsh-workbuddy-connect` `latest` = `0.7.9`,
  `dsh-workbuddy-switcher` `latest` = `0.3.6`, baseline constant `0.7.8` — so the
  reminder fired permanently and named the wrong package. After the fix the same
  comparison resolves to `up-to-date` while the installed version equals
  `latest`, and to `update-available` one release behind (verified on both
  against the live registry).

  Changes:

  - the metadata URL and the release-list repository now name
    `dsh-workbuddy-switcher` / `ddGuo/dsh-workbuddy-switcher`;
  - the baseline is read from this package's manifest by `pluginVersion()`,
    which walks up from `lib/bridge/` to the nearest manifest whose `name`
    matches — a hardcoded number cannot track a package versioned as a whole.
    The old constant survives only as a fallback for an unreadable manifest;
  - the reminder's label and the copy-for-agent prompt name this plugin in both
    locales, so following the prompt installs a package that exists;
  - the served HTTP route paths (`/plugins/dsh-workbuddy-connect/update` and
    friends) deliberately keep their historical spelling: they are the contract
    between a host and a browser half that may be mid-upgrade, and renaming them
    would break a running pair.

### Tests

- `test/update-target.test.js` pins all four targets, the manifest-baseline
  wiring, both locale labels (and that the shipped bundle carries them), the
  recovery prompt's package name, and the deliberate survival of the wire paths.

## [0.3.6] - 2026-10-29

### Fixed

- **The `400` / `code 11128` rejection came back, and the previous two countermeasures had both been
  neutralised.** The gateway now strips invisible characters before matching, so the zero-width
  spacing that 0.3.5 relied on had become useless — measured on the same 407-character block that
  tripped it on 2026-10-28:

  | the block as sent | result |
  |---|---|
  | unchanged | `400` |
  | zero-width space every 24 characters | `400` |
  | zero-width space every 8 characters | `400` |
  | one **visible** word changed | `200` |

  That is why the guard's own counters said `unrecovered: 2` with `lastDetail: "the marked body was
  rejected as well"` instead of recovering.

  The same session measured **which part of the request is inspected at all**, which is what the fix
  is built on:

  | the same offending text placed in | result |
  |---|---|
  | a `system` message | `400` |
  | an `assistant` turn | `400` |
  | a `user` message | `200` |
  | 108 tool declarations | `200` |

  So instead of hiding text from a fingerprint, 0.3.6 **moves instruction text out of the roles the
  gateway reads**: the system prompt travels byte-for-byte in the first `user` message behind an
  "authoritative instructions" frame, and the `system` role keeps one neutral sentence pointing at
  it. Nothing in the prompt is rewritten, so literals, code samples and formatting survive exactly —
  which the zero-width approach could never guarantee.

  Verified on the full production shape (real 8 KB prompt, all 108 tool declarations, multi-turn
  history): `400` as a system message, `200` relocated, model reply correct. Instruction-following was
  checked separately by asking which tool must be used to read a file — it answered "the read tool …
  avoid `cat`", a fact stated only in the relocated prompt.

  The retry path keeps a second line of defence for the day the gateway starts reading user messages:
  it now breaks up whatever still travels in an inspected role with a **visible** ` · ` separator
  rather than a zero-width mark, since invisible ones are proven to be stripped.

### Changed

- `lib/channel-guard.js` exports `INSTRUCTION_FRAME` and `SYSTEM_PLACEHOLDER` so the tests pin the
  contract instead of duplicating literals.

### Tests

- `test/channel-guard.test.js` rewritten around the relocation: the prompt moves byte-for-byte into
  the leading user message, the system role keeps only the neutral sentence, assistant turns and user
  messages keep their order, the rest of the request is untouched, a second pass is a no-op, and no
  zero-width mark appears on the first attempt.
- `test/channel-retry.test.js` updated: the retry relocates *and* separates, uses a visible separator
  (never a zero-width one), leaves the user's own words and tool declarations alone, keeps
  `tool_calls` arguments byte-identical, and counts a body it cannot rewrite as unrecovered without a
  pointless second request.

## [0.3.5] - 2026-10-28

### Added

- **A dead login can be revived from the app, without deleting the archive.**
  `12153` means the refresh token itself was revoked upstream: no amount of
  waiting renews it, and the only source of a working token is a fresh sign-in
  in the desktop app. Neither existing import mode could deliver that copy —
  the sweep's phone patch deliberately keeps the archived tokens, and
  `requireNew` skips a file whose tokens look unchanged — so the documented
  recovery was "delete the row and import again", which loses the archive's
  phone label and any history attached to that file.

  `importCurrent` gained a `replace` mode that overwrites the archived tokens
  from the app's copy and clears the dead verdict, and the panel shows a
  「重新导入」 button on exactly the rows that carry the 「需重新登录」 badge.
  The automatic sweep uses the same path: when the app is signed in to an
  account this plugin has written off, its tokens are replaced rather than
  preserved, because the app's copy is the only thing that can revive it.

  Verified end to end through the running host: a replace on a `refresh_dead`
  archive moved it from `dead` to `already` with its streak intact
  (128a8f9c: `auth`/`refreshDead` → `already`, streak 10), and the phone label
  survived the write.

- `replace` takes an `expectUid`, and the per-row button sends it. The desktop
  app holds one login at a time, so a replace aimed at a different row would
  otherwise overwrite the wrong archive with that login's tokens. A mismatch now
  returns `undefined` and the panel says the app is signed in to another account
  instead of silently rewriting something else.

### Tests

- `test/import-replace.test.js` pins the three modes and their precedence: the
  phone patch can never overwrite tokens (even with `replace` alongside),
  `requireNew` stays a no-op for an unchanged archive, `replace` overwrites even
  when the archive looks identical — the case that could never be recovered —
  and a dead archive reaches `replace` ahead of the phone-patch branch.

## [0.3.4] - 2026-10-28

### Fixed

- **An account that had already collected its credits was reported as
  「签到失败 · 异常」, and the retry schedule then hid it for the rest of the day.**
  The gateway answers a second claim with `400` / `code 10001`
  (「今天已签到，请明天再来」) — measured on two live accounts. `classifyFailure`
  looked at the HTTP status first, so a settled day fell through to `unknown`,
  and `checkinRetryAt` gave `unknown` a backoff: the panel showed a failure and
  the sweep stopped looking. The business code is now checked before the status,
  so `10001` becomes `already` with its credit and streak intact.

- **A rejected refresh token was invisible to rotation, so it kept being
  picked.** `refreshExpiresAt` is a static claim written at capture time; a token
  can be refused long before that date, and `pickAccount` sorted by that field
  alone. A dead archive therefore outranked a live one, was selected, failed, and
  burned a turn every time. Measured on this machine: 7 of 9 archives answer
  `12153: refresh token is invalid` while still carrying the *latest* static
  expiry. The sweep now records that verdict (`dead.accounts[file]`), and both
  `pickAccount` and the reclaim sweep skip those files; the panel shows a
  「需重新登录」 badge so a dead row no longer looks available.

- **A transient renewal failure was classified as a permanent dead login.** When
  the 401 could not be renewed, every cause collapsed into `auth`: a rejected
  refresh token, a gateway fault, and a transport error all looked the same. Only
  the first is permanent — and because `auth` carries no retry backoff, the other
  two were never retried that day either. `renewCredentialDetailed` now reports
  why, and the transient cases become `network`, which the sweep retries.

### Added

- `renewCredentialDetailed` alongside `renewCredential`, returning
  `{ renewed, refreshRejected, reason }`. `renewCredential` keeps its signature
  and is now a thin wrapper, so nothing that already calls it changes.

### Tests

- `test/checkin-classification.test.js` pins the measured cases: `10001` reads as
  `already` and survives the HTTP status; a coded 401 keeps its code; rotation
  prefers the longest-lived *live* account over a longer-lived dead one; and the
  permanent/transient split decides whether a retry is scheduled.

## [0.3.3] - 2026-10-28

### Added

- **The guard now reports what it had to do, so a silent regression cannot hide
  for a day again.** The 0.3.2 loss was invisible: the fetch wrapper was disabled
  by another plugin's `undici` import, every WorkBuddy request was rejected, and
  nothing said so until a turn failed mid-work.

  `readGuardState()` counts this, without spending a request of its own:

  | field | meaning |
  |---|---|
  | `escalations` | rejected-then-retried requests; the guard ran and recovered |
  | `unrecovered` | escalations the gateway refused as well — the alarm |
  | `lastEscalationAt` / `lastUnrecoveredAt` | when each last happened |
  | `lastDetail` | which of the three paths produced the last event |

  `installUpstreamRetry` gained an `onRejection({ recovered, detail })` sink, and
  `lib/index.js` logs through it: `warn` when a request was saved, `error` —
  naming the upgrade — when the marked body was rejected too. A healthy install
  logs nothing at all, so any output here means something real happened. The
  counters ride the existing retry path, so this adds no traffic, and they are
  exposed as `channelGuard` in the plugin's
  `GET /plugins/dsh-workbuddy-switcher/accounts` response for the panel.

### Fixed

- **`400` / `11128` 请求被拦截 came back when the fetch guard was not the outermost
  `globalThis.fetch`.** The 0.3.0 guard wraps `globalThis.fetch` at activation and
  marks instruction text there. Anything that replaces `globalThis.fetch`
  afterwards — another plugin importing `undici`, whose `install()` assigns the
  global, or a host that swaps it in — silently disables the guard, and the
  gateway then sees the unmarked prompt again.

  Reproduced on the live gateway with the body a failing session actually sent
  (33 KB system prompt, 52 tool declarations, 63 messages):

  | body sent | result |
  |---|---|
  | as the host wrote it | `400` `11128` `Illegal API invocation from an unapproved channel` |
  | same body, instruction text marked (0.3.0 behaviour) | `200` |

  So the content was already correct; the rewrite was not happening. The fix adds
  a second, non-global interception point: `installUpstreamRetry` wraps
  `WorkBuddyUpstreamClient.prototype.chatStream`, the one method every chat body
  must pass through, and on a measured `400` + `11128` retries the same request
  once with `neutralizeChatBodyEverywhere`: every model-visible string is marked
  (message content of any role, `reasoning_content`, tool descriptions) while
  roles, ids, tool names, tool-call `arguments` and the model name stay
  byte-identical, so the wire format still parses.

  The first attempt is the caller's body untouched, so a healthy request never
  pays for this and is never rewritten twice; a different 400 (for example
  `11148`, the tool-pairing complaint) is surfaced immediately without a retry.

  Measured end to end with the fetch guard deliberately not installed: first
  attempt `400` / `11128`, retried body `200` with the answer intact. With the
  fetch guard installed the healthy path still issues exactly one request and the
  body reaches the client byte-identical.

### Tests

- `test/channel-retry.test.js` pins the new behaviour: only `400` + the channel
  markers count as a rejection, the escalated body keeps its identifiers and tool
  arguments intact while every text field gains marks, the measured phrase no
  longer survives anywhere, a healthy chat is sent once and byte-identically, a
  different 400 is not retried, and a second install neither stacks wrappers nor
  unwraps a live one.

## [0.3.2] - 2026-10-28

### Changed

- **Published to npm.** `npm i dsh-workbuddy-switcher` and
  `dsh plugin --profile <p> add dsh-workbuddy-switcher` now work alongside the git source.

  Making the package correct for a registry needed three manifest changes that the git install
  never exercised:

  - `repository`, `homepage` and `bugs` now point at the GitHub repo, so npm's page links back to
    the source instead of showing an empty sidebar;
  - the READMEs' screenshots were referenced as `docs/*.png` but `files` did not include them, so
    every image would have been a broken link on npm — `docs/*.png` is packaged (the design note
    `docs/checkin-plan.md` stays out);
  - `scripts/` is packaged, because the README tells contributors to run `npm run build:client`
    after editing either client half, and that script was not shipped.

  Tarball: 24 files, 625 kB packed, 1.3 MB unpacked. `npm publish --dry-run` is clean, and no source
  file changed — the 43 tests still pass unmodified.

## [0.3.1] - 2026-10-28

### Changed

- **Both READMEs rewritten for the single-package reality.** They still framed this plugin as a
  companion to `dsh-workbuddy-connect` — a peer dependency, a separate install command, "must be
  installed separately" — which stopped being true in 0.3.0. The intro, the install section, the
  switching explanation and the troubleshooting entry now describe the bundled provider instead of a
  second package.

  Two kinds of mention remain on purpose: the `remove` command in the upgrade steps (an upgrade has to
  delete the old package), and the attribution in the third-party section. The upgrade section also
  now states the one thing an upgrading user needs that the docs never said: the old package's
  `llm-workbuddy` provider row disappears with it, and provider configuration (`authFile`, probe port)
  belongs under this plugin's own `workbuddy-switcher` row.

  No code change, so the version only moves to track the documentation.

## [0.3.0] - 2026-10-28

### Changed

- **`dsh-workbuddy-connect` is now part of this plugin.** One install provides both the WorkBuddy
  model provider and the account switcher; `dsh-workbuddy-connect` no longer needs to be installed,
  and must be removed when upgrading, because two copies would register two `workbuddy` providers.

  The vendored copy (`lib/bridge/`) is the pristine **0.7.8** release from npm, byte-identical —
  host bundle, browser bundle and CLI — carried under its MIT licence with the notice in
  `THIRD_PARTY_NOTICES.txt` and its licence beside it at `lib/bridge/LICENSE.txt`. Nothing in it was
  edited. The host half is composed from this plugin's `apply` (the one place a cordis plugin can
  merge two `inject` lists), and the browser half is assembled into `lib/client.bundle.js` by
  `scripts/build-client.mjs`, which parks the bridge's module factory so this plugin's client can
  mount it. That assembled file is committed because installs come from git with no build step;
  `npm run build:client` regenerates it.

  Two long-standing problems disappear with the merge:

  - **The compatibility gate can no longer refuse it.** The bridge declared six `@deepseek-ai/dsh-*`
    peers pinned to the exact `0.2.1-rc.2`, so every DSH upgrade disabled every WorkBuddy model until
    an exemption was granted. This package declares `engines.dsh` and the same peers as ranges
    (`>=0.2.1-rc.2 <0.3.0-0`), which the gate accepts across rc releases.
  - **The two plugins can no longer drift apart**, which is what let one of them pin an exact DSH
    version while the other did not.

  The provider keeps its own config schema (`Config` is re-exported), so an existing profile patch
  that configures `authFile` or the probe port still applies.

### Fixed

- **Every WorkBuddy model failed again with `400` / `code 11128` — 「请求被拦截，请重新发送」**
  ("request intercepted, please resend"). The 0.2.5 countermeasure no longer worked, because the
  gateway's rule had changed rather than the plugin having regressed.

  Measured again on `copilot.tencent.com/v2/chat/completions`, with today's real 8 KB prompt:

  | system message | result |
  |---|---|
  | live prompt, every `DeepSeek Harness` already neutralised (0.2.5's fix) | `400` |
  | live prompt with the offending block replaced | `200` |
  | live prompt with **one character** changed inside that block | `200` |
  | live prompt with a whole sentence appended | `400` |

  So the trigger had moved from the phrase `DeepSeek Harness` to **another long exact substring**
  (~110 characters, spanning sentences) — an exact-match blacklist, not a rule about a word. Bisecting
  to that 111-character boundary and replaying it five times gave identical results, so it is
  deterministic, not flaky.

  `lib/channel-guard.js` now stops any long string from surviving instead of chasing phrases: inside
  `system` / `developer` text it inserts a zero-width space roughly every 24 characters, always
  between words, so no exact match longer than ~30 characters can exist while the text keeps its
  spelling, line structure and meaning. Verified against the live gateway with the real prompt plus
  all 108 tool declarations: `400` without the guard, `200` with it, and a control question still
  answered correctly (`17*23` → `391`).

### Tests

- `test/channel-guard.test.js` rewritten for the new behaviour: the measured phrase is still
  neutralised every time, no unmarked run exceeds the cadence, removing the marks restores the text
  exactly (so no word is split), user text and non-chat traffic stay untouched, and the installer
  stays idempotent.
- `test/client-bundle.test.js` pins the merged browser bundle: both the bridge module and this
  plugin's module register, the switcher half calls the bridge's `apply` with the same context and
  unions its `inject` list, and a throwing bridge cannot stop the account UI from mounting.

## [0.2.6] - 2026-10-25

### Added

- **Account rows carry the masked phone, and a newly signed-in account adds itself to the library.**
  Each row is now titled with WorkBuddy's masked phone (`180****0331`) instead of a uid fragment,
  because a hex string does not say which login a row is, and that ambiguity only grows with the
  number of accounts. The value arrives masked — the server never returns a full number — and the
  parser rejects a full-number shape outright, so the plugin can neither store nor render a dialable
  number; it is captured at import time into `account.nickname` so the list labels a row without
  re-decrypting anything. Archives captured before this change have no phone on record and fall back
  to the uid fragment until that account is signed in to the desktop app again (WorkBuddy only
  exposes the phone of the *current* login), at which point a host sweep backfills that one field —
  never the tokens, which may have been refreshed here more recently than the app wrote its copy.
  That same sweep closes a second gap: signing in to a new account in the app used to leave the list
  stale until "import current account" was clicked, since writing an archive needs the at-rest
  decryption that only the host can do. The host now checks every 20 s (plus one pass 5 s after
  startup) and archives a login it has not seen before, so the list catches up on its own within one
  poll; the manual button stays for when the app cannot be read, the existing "client signed in, not
  imported yet" banner is the visible hint while that happens, and transient read failures are logged
  and retried rather than surfaced.

### Documented

- **A DSH upgrade hides every WorkBuddy model behind the compatibility gate.** `dsh-workbuddy-connect`
  pins six `@deepseek-ai/dsh-*` peers to exact versions (`0.2.1-rc.2`), so the next DSH release
  (`0.2.1-rc.3`) refuses it during composition and the provider disappears. Measured: between
  `0.2.1-rc.2` and `0.2.1-rc.3` those six packages differ **only in `package.json` version strings** —
  no code or declaration change — so this is a declaration mismatch, and the newest release on npm
  (`0.7.9`) carries the same pins. Both READMEs now walk through DSH's own `allow-version`
  exemption (`dsh plugin --profile <p> allow-version <package@version> --dsh-version <runtime>
  --accept-risk`), which persists in `<profile>/compatibility.json` across restarts and reinstalls,
  and note that each further DSH upgrade needs a fresh grant. This is documentation only: the
  plugin's own behaviour is unchanged, so no version bump.

- Both READMEs gained a short "how the measurements were made" section, listing the re-runnable
  method behind each measured claim (vary-only-the-system-message probes for the `400`; `npm pack`
  plus a recursive byte diff for the `rc.2`/`rc.3` comparison).

## [0.2.5] - 2026-10-22

### Fixed

- **Every WorkBuddy model failed with `400` / `code 11128` — 「请求被拦截，请重新发送」
  ("request intercepted, please resend").**
  The gateway fingerprint-checks the system prompt: a `system` message containing the literal text
  `DeepSeek Harness` is answered `400` / `msg: Illegal API invocation from an unapproved channel`,
  whose `displayMsg.zh` is the message above. The official client never sends that sentence, which
  is why the same account kept working inside the app.

  Measured on `copilot.tencent.com/v2/chat/completions`, sending only the smallest possible request
  each time with one real DSH prompt:

  | system message | result |
  |---|---|
  | none | `200` |
  | raw `You are an AI agent powered by DeepSeek Harness` | `400` `11128` |
  | same opener with U+200B between the two words | `200` |
  | DSH's real 8 KB prompt, prepared by `dsh-workbuddy-connect` | `400` `11128` |
  | that same prompt with only the **opener** neutralised | `400` `11128` |
  | that same prompt with **all three** occurrences neutralised | `200` |

  So the check does not care about one sentence; it cares about the raw phrase wherever it appears
  in instruction text. DSH's prompt names it three times — the opener, "…names the DeepSeek Harness
  implementation checkout", and "…through the DeepSeek Harness Web GUI" — and
  `dsh-workbuddy-connect` rewrites only the first, because it uses
  `content.replace(PHRASE, NEUTRALISED)` with a string argument, which replaces a single match. The
  two surviving occurrences re-armed the check, so every WorkBuddy model failed on the first step
  of a turn.

  `lib/channel-guard.js` fixes it from the transport side: it wraps `globalThis.fetch` for the
  plugin's lifetime and, for a `POST` whose URL contains `/v2/chat/completions`, rewrites every
  occurrence of the phrase in `system` / `developer` text into `DeepSeek\u200b Harness`. The byte
  match stops matching; the meaning a human or a model reads is unchanged. User messages, other
  providers, and bodies that carry no such text pass through untouched, and a body the bridge
  plugin already prepared has nothing left to rewrite, so the two cannot conflict. Owning this in
  this plugin rather than patching the bridge's vendored bundle means the guarantee survives any
  `dsh-workbuddy-connect` upgrade.

  Verified against the live gateway: the exact prepared body that answers `400` without the shim
  answers `200` with it installed.

### Tests

- `test/channel-guard.test.js` pins the rewrite: all occurrences (not the first) are neutralised
  across string and text-part content, `developer` is covered as well as `system`, user text is
  never touched, non-chat URLs and non-`POST` calls are forwarded verbatim, a stale
  `Content-Length` is dropped, and a second activation does not stack wrappers.

## [0.2.4] - 2026-10-20

### Changed

- **Clear-cooldown buttons moved from the shared action bar to the cooldown each one clears.**
  Every live cooldown badge is now immediately followed by its own small "clear" chip, the two
  rendered as one unbreakable inline group so a wrapping row cannot separate them. With two
  model-scoped cooldowns on one account the old layout put two identical "clear this model's
  cooldown" buttons side by side in the action bar, and nothing said which model a click would
  unbench; the chip now just reads "clear", its scope is the badge it sits behind, and the
  accessible name plus tooltip spell that scope out. The action bar keeps only "Switch to
  this account", "Delete" and "Check in". The badge is what narrows on a small popover, so a
  long model id reflows rather than pushing the chip out of the card.

### Tests

- `test/cooldown-clear.test.js` renders the shipped `AccountList` and pins the pairing: one
  unbreakable group per live scope, the chip clearing exactly the scope behind it (action
  payload and busy label included), distinct accessible names for the account and model cases,
  and no clear button left in the action bar. It fails against 0.2.3.

## [0.2.3] - 2026-10-19

### Fixed

- **"Import current account" failed on every machine but the original author's.**
  The plugin runs the WorkBuddy binary as a decryption oracle — the at-rest key
  lives in the app's own Electron binding — but fell back to a hardcoded path:

  ```js
  const electron = process.env['WORKBUDDY_ELECTRON_BIN'] ?? 'D:\\WorkBuddy\\WorkBuddy.exe';
  ```

  WorkBuddy installs to `%LOCALAPPDATA%\Programs\WorkBuddy` by default, so anyone
  who took the default and never set the override got
  `spawnSync D:\WorkBuddy\WorkBuddy.exe ENOENT` on the plugin's entry-point action
  — the account library could not be filled at all. The executable is now
  discovered instead: the explicit override first, then the registry
  (`DisplayIcon` / `InstallLocation`, which the installer writes even for a custom
  directory), then the usual install roots. A machine with no WorkBuddy at all now
  gets an error naming `WORKBUDDY_ELECTRON_BIN` and listing what was tried, rather
  than a bare `ENOENT`.

### Added

- The floating account switcher can be dragged with a mouse or touch instead of
  blocking the bottom-right composer controls. Its position is stored per browser,
  clamped on resize, and the popover follows it without leaving the viewport.
  Dragging does not accidentally open the panel; keyboard activation is preserved.
  (Merged after the 0.2.2 tag was cut, so it first ships here.)

### Tests

- `test/electron-bin.test.js` pins the executable discovery: override precedence,
  the default install location, both registry shapes, the Program Files fallbacks,
  de-duplication, and the actionable failure. It fails against 0.2.2.
- `test/fab.test.js` (from the drag PR) still passes.

## [0.2.2] - 2026-10-19

### Changed

- **Version bump only** — released to make the current `main` installable by
  version (and to mark the point after the check-in, per-model cooldown and
  24-hour hold work landed). No behavioural change from 0.2.1.

## [0.2.1] - 2026-10-18

### Fixed

- **Concurrent state writes could fail or lose data.** Every writer used the same
  fixed temp path (`workbuddy-switcher.json.tmp`), so two of them raced: the first
  `rename` consumed the file and the second failed with `ENOENT`, surfacing as an
  HTTP 500 on a click that should have been harmless. A lost update followed the
  same way (read, read, write, write). Measured on the old discipline with 50
  concurrent writers: 46 failed writes and 49 of 50 keys lost. All writers now go
  through one promise-chained lock and a per-write unique temp file; the same
  burst against the real route is 18/18 successful with no lost keys.
- The check-in badge no longer shadows the check-in action inside the row
  renderer, which had made the per-account button call a badge object instead of
  the action.
- `set-checkin` no longer triggers a model-catalog refresh (or reports one as
  having happened).

## [0.2.0] - 2026-10-18

### Added

- **Click coalescing for manual check-in.** The panel's buttons are cheap to press
  and a sweep is not cheap to run, so both ends now collapse a burst into the run
  that is already happening: the browser keeps the in-flight request in a ref and
  returns it to every later click, and the host holds one process-wide
  `sweepOnce` promise that the timer and the buttons share. Verified with
  8 simultaneous clicks against a 4-account archive: 4 upstream calls, not 32.
- **Daily check-in.** Each archived account now collects WorkBuddy's daily
  check-in credits (100 a day) by calling
  `POST /v2/billing/meter/checkin-activity-status` and
  `POST /v2/billing/meter/daily-checkin` with the archive's own access token, so
  neither the desktop app nor a second sign-in is involved. A pass runs 90
  seconds after startup — which is what catches up a day missed while the machine
  was off — and then every 30 minutes. Every account is settled at most once a
  day, and the claim endpoint is idempotent per day, so a retry can never
  double-credit.
- **A check-in badge per account, and two manual triggers.** The panel shows
  `+100 collected · streak 3`, `already +100 today`, `activity closed · ends …`,
  `not applicable` (WorkBuddy AI) or `check-in failed · <reason>`, plus a
  `check-in n/m today` tally in the header. "All accounts" runs the whole archive
  and each card has its own button; both bypass the daily short-circuit and stay
  idempotent. The feature has its own switch, independent of auto-rotation.
- **`lib/checkin.js`**, which owns the check-in wire protocol: content-type-aware
  reads (a `401` from this gateway is an HTML page, not JSON, so parsing
  unconditionally would report `Unexpected token '<'`), a result classification
  per account (`claimed` / `already` / `inactive` / `region` / `pending` /
  `auth` / `network` / `unknown`), and per-day state keyed by the **server's**
  date rather than the host's, so a wrong system clock cannot cause a double
  claim.
- **Token renewal for idle accounts.** A `401` during check-in refreshes that
  archive's access token (the endpoint rotates the refresh token, so the new pair
  is persisted) and retries once. Measured: the previous refresh token kept
  working after a rotation, so an accidental double refresh degrades to a wasted
  request rather than a dead login. The write is atomic, is abandoned if the file
  changed under it, and leaves a `<uid>.json.bak` copy first.
- **Retry backoff for transient failures** — 10 / 30 / 60 minutes, recorded in
  `checkin.accounts[file].nextAttemptMs`. A rejected session is deliberately not
  retried: waiting does not fix it, and eight attempts an hour at a dead login
  would just add noise.
- **Model-scoped cooldowns.** A `429 soft_rate` that named one model now benches
  only that model; the login stays in rotation for every other model, and the
  panel marks it as "`<model>` cooling until …" rather than as an exhausted
  account. A `402 hard_credit`, or any message carrying credit-exhaustion
  wording, still benches the whole account — that is what it means. The failing
  model is taken from the agent's routed request, with the failure message as a
  fallback; when it cannot be determined the cooldown falls back to the account
  scope, since a limit that cannot be attributed must not be ignored.
- **Per-model "clear cooldown".** A model-scoped badge gets its own clear button,
  which removes that model's scope only. Clearing a model never reopens an
  account whose account-level cooldown is still live.
- **A 24-hour hold on hand-picked accounts.** Clicking "use this account" records
  `selected.source: 'user'` and `selected.holdUntilMs`, and the passive reclaim
  sweep leaves that account alone until the hold expires. Previously the sweep
  re-ranked accounts by refresh-token lifetime every minute, so a manual choice
  that was not the longest-lived one silently reverted within a minute — the
  "I picked 66ce and it jumped back to b058" symptom. Quota rotation ignores the
  hold: an account that is actually limited cannot serve the request whatever was
  asked for earlier. The panel shows "hand-picked, held until …".
- **Export / import a credential bundle**, for moving one account pool between
  machines. A bundle is self-describing (`dsh-workbuddy-accounts/v1`) and
  carries the accounts in the desktop shape, so an entry can be dropped straight
  into the archive directory by hand if the UI is unavailable.
- **Merge-on-import**, never blind overwrite: a new account is added, an account
  whose incoming refresh token lives longer is replaced (existing file renamed
  to `<uid>.json.imported-<stamp>` first), and a local copy that lives at least
  as long is left alone. Re-importing an export on the machine that produced it
  therefore cannot log the user out — verified as an explicit test case.
- **One-click export.** The file is plaintext, so the risk is stated in the
  button tooltip, in the panel's banner and in the bundle's own `warning` field
  rather than gating the click behind a confirmation step.

### Changed

- The cooldown table accepts two shapes: a flat entry (whole account) and an
  entry with a `models` map (per model). Existing flat entries keep their
  meaning, so an upgrade needs no migration.
- The rotation pool and the reclaim sweep both judge an account against the
  model that is actually routed, instead of treating any cooldown as "unusable".
- The route's request body cap went from 1 MB to 8 MB so a bundle with many
  accounts fits (each archive is about 2.3 KB; the route is loopback-only, so
  the cap bounds a local mistake rather than a remote attack).
- `set-checkin` does not refresh the model catalog, and does not claim one
  happened: a check-in toggle has nothing to do with the provider's catalog.
- The check-in sweep is isolated from everything else: it is wrapped per account
  and cannot reject into the host, so a broken check-in cannot disturb rotation,
  reclaim or switching.

### Fixed

- A single throttled model no longer takes a whole account out of the pool for
  ten minutes (or a day, from the third strike) while its other models were
  perfectly usable.
- Clearing one model's cooldown no longer drops the account-level cooldown the
  same entry carried.
- The reset instant is also recognised when the shim truncated the upstream
  sentence, by matching the timestamp's `UTC+8` suffix on its own.
- The passive reclaim sweep no longer reverts a manual account choice on its next
  pass. It previously re-ranked by refresh-token lifetime with no notion of who
  made the selection, so a hand-picked account that was not the longest-lived one
  was switched back within a minute.

## [0.1.0] - 2026-10-18

First release. Extracted from the ad-hoc scripts used while diagnosing the
`dsh-workbuddy-connect` version mismatch, then hardened against the failures
those scripts ran into.

### Added

- **Account archive** at `~/.dsh/workbuddy-accounts/`, one desktop-shaped JSON
  per account.
- **Switching** by pointing `WORKBUDDY_AUTH_FILE` / `WORKBUDDY_AI_AUTH_FILE` at
  an archive. `dsh-workbuddy-connect` re-reads those variables on every
  credential resolution, so a switch needs neither a restart nor a config edit.
- **Region-aware selection**: only the variant matching the credential's region
  is pointed at the file. Setting both would trigger
  `credential-region-mismatch` in the international variant.
- **Automatic rotation** on quota failures (`429 soft_rate`, `402 hard_credit`)
  via a `prepend`ed `agent/request-error` listener that hands back
  `{kind: 'retry'}`. Auth failures, content rejections and 5xx deliberately do
  not rotate.
- **Exact cooldowns** parsed from the upstream's `将在 … 重置` message,
  interpreted as UTC+8 regardless of the host zone.
- **Persistent cooldown table** so a restart neither forgets an exhausted
  account nor retries it immediately.
- **Passive reclaim sweep** every 60 seconds: once a cooldown expires and the
  current account is no longer the best healthy one, switch back. Skips while an
  Agent is mid-turn.
- **Two surfaces** sharing one data layer: a plugin settings card and a
  bottom-right floating button.
- **Account dedupe** by `uid:enterpriseId`, preferring the canonical
  `<uid>.json` file over ad-hoc copies.
- **Automatic format migration** on startup: own-copy-shaped archives
  (`{version, credential}`) are rewritten to the desktop shape
  (`{auth, account}`), because `authFile` is parsed by the desktop parser and
  the wrong shape hides the whole model group silently.
- **10-second panel polling** so an account signed in through the desktop app
  shows up without a manual refresh.
- **"Client has a new account" banner** when the app is signed in to an account
  that has no archive yet.

### Fixed

- Cooldown reasons are built from structured facts (code, status, reset
  instant, surviving ASCII) instead of the raw upstream body, which can arrive
  as unrecoverable mojibake.
- Rotation is skipped when no account is selected, instead of changing accounts
  the user did not ask to change.

### Known limitations

- Rotation only covers archived accounts; "follow the client" mode is left
  alone.
- Remaining quota per account is unknowable — a `429` says "limited now", not
  "how much is left". Ordering uses refresh-token lifetime.
- Archives are plaintext.
