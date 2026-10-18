# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

- The route's request body cap went from 1 MB to 8 MB so a bundle with many
  accounts fits (each archive is about 2.3 KB; the route is loopback-only, so
  the cap bounds a local mistake rather than a remote attack).

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
