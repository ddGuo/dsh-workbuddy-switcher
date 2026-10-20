# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Next release notes go here.

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
