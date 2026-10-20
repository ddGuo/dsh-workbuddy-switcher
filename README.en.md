# DSH WorkBuddy Switcher

English | [中文](./README.md)

Manage a pool of WorkBuddy accounts inside DeepSeek Harness and switch between them at will — with **automatic rotation when an account runs out of quota**.

> A companion plugin for [`dsh-workbuddy-connect`](https://github.com/corrinehu/dsh-workbuddy-connect). That plugin brings WorkBuddy models into DSH; this one schedules work across multiple accounts.

---

## The problem

`dsh-workbuddy-connect` uses one account at a time. Switching means either signing in again inside the WorkBuddy desktop app or hand-editing a config file. WorkBuddy also has a daily quota, so once an account is exhausted it is unusable for the rest of the day.

Across machines — the office and home, say — the archives are also independent: an account signed in on machine A has to be signed in again on machine B.

This plugin does five things:

1. **Account archive** — stores each account's credentials locally, so switching no longer requires the desktop app
2. **One-click switching** — from the plugin settings card or a floating bottom-right button; the model list refreshes immediately
3. **Automatic rotation** — on a quota failure it moves to the next account and retries, so the interruption is invisible
4. **Cross-machine sync** — export one file, import it on the other machine, and the two archives line up
5. **Daily check-in** — every account collects its 100 free credits each day, and a missed day is caught up after the next boot

## Features

### Archive and switching

- Archive directory: `~/.dsh/workbuddy-accounts/`, one JSON per account
- "Import current account" stores whichever account the WorkBuddy app is signed in to
- Duplicate copies of the same account are collapsed to the canonical file
- The panel polls every 10 seconds, so a freshly signed-in account appears by itself

### Moving accounts between machines

Use this to share one account pool between, say, the office and home machines:

- **Export** packs the whole archive into one downloadable file
- **Import** merges such a file into the local archive

**Import merges, never overwrites blindly:**

| Case | Result |
|---|---|
| account not present locally | added |
| present locally, **incoming** refresh token expires later | replaced (the existing file is first renamed to `<uid>.json.imported-<stamp>`) |
| present locally, **local** expires later or equal | local copy kept untouched |

The last row is the important one: **re-importing an export on the machine that produced it cannot log you out.**

> ⚠️ **An export file contains plaintext tokens** — it *is* those logins. Keep the file in your own encrypted storage and delete it when done.
>
> Reminder: once credentials leave the machine they **cannot be revoked remotely**. WorkBuddy only offers account-level revocation (change the password); there is no per-session or per-device kill switch.

### Automatic rotation

| Upstream result | Action | Why |
|---|---|---|
| `429 soft_rate` (**no** credit wording) | ✅ cool **that model only**, rotate and retry | a different account recovers instantly, while the same login still serves every other model |
| `429 soft_rate` + credit wording | ✅ cool the **whole account**, rotate and retry | it really is an exhausted balance, riding on a 429 |
| `402 hard_credit` | ✅ cool the **whole account**, rotate and retry | same |
| `401` / `12153` | ❌ no rotation | another account does not fix an expired session |
| Content rejection | ❌ no rotation | unrelated to the account |
| `5xx` | ❌ no rotation | left to `dsh-llm-retry` backoff |

#### The limit is bound to the model

This is what separates the plugin from "a 429 means the account is dead".

WorkBuddy answers a **single throttled model** and a **spent account balance** with the same `429 soft_rate`, so the status code alone cannot tell them apart. The cooldown is therefore recorded against the scope the failure actually describes:

| Signal | Scope |
|---|---|
| `402`, or wording like "insufficient credit" / "quota exceeded" | the whole account (every model) |
| `429 soft_rate` alone | only the model the failed request used |
| the model cannot be determined | the whole account (conservative) |

So after an account is throttled on `claude-sonnet-4-5`:

- it drops out of the candidate pool **for that model**, and the request moves to a sibling login;
- it stays a healthy account **for every other model**, and keeps taking part in rotation and reclaim;
- the panel says "claude-sonnet-4-5 cooling until …" instead of making the whole login look out of quota.

Cooldown length:

- upstream message carries a reset instant → **cooldown ends exactly then**
- no reset instant → 10 minutes for the first two strikes, 24 hours from the third

Cooldowns are persisted, survive restarts, expire on their own, and a once-a-minute sweep **switches back** to a better account afterwards.

### Daily check-in

Every archived account collects WorkBuddy's daily check-in credits (**100 credits a day** at the time of writing) without opening the desktop app.

- **Catches up after a missed day** — one pass 90 seconds after startup, then every 30 minutes. The pass that was missed while the machine was off simply happens at the next boot.
- **Idempotent** — the upstream de-duplicates per day; claiming twice answers "already checked in today" and grants nothing, so a retry cannot double-credit or double-charge.
- **Only asks applicable accounts** — WorkBuddy AI (international) has no such activity; those archives are marked "not applicable" and no request is sent.
- **Season-aware** — once the activity closes (`active: false`) the state is re-checked at most once a day, and the panel shows the closing date.
- **Failures stay local** — one account's `401` or timeout never stops the others, and rotation/reclaim are untouched by anything the check-in does.

Each row carries a badge: `+100 collected · streak 3` / `already +100 today · streak 12` /
`check-in failed · token rejected` / `activity closed · ends 10-31`. The header shows
`check-in 3/4 today`; the footer has the **daily check-in** switch and an **all accounts**
button, and every card has its own **check in** button.

> **Tokens renew themselves.** On a `401` the plugin exchanges the archive's refresh token
> for a fresh access token and writes it back atomically — after re-reading the file and
> abandoning the write if another writer got there first. That is what keeps a pool account
> that has not been selected for weeks from silently going unable to check in.

#### What each badge means

| Badge | Meaning | What happens next |
|---|---|---|
| `+100 collected` | actually collected just now | no more requests for this account today |
| `already +100 today` | collected earlier today (possibly by the app) | no more requests today |
| `activity closed` | season not running or finished | at most one status query a day |
| `not applicable` | WorkBuddy AI has no check-in | no request sent |
| `check-in failed · token rejected` | 401/403, and the refresh did not help | no retry; the account needs a fresh sign-in |
| `check-in failed · network` | timeout / 5xx / 429 | retried in 10 / 30 / 60 minutes |
| `check-in failed · error` | any other business error | same backoff; hover for the raw `msg` |

#### Manual check-in

- **All accounts** — runs the whole archive right now, ignoring the "already collected today" short-circuit
- **Per-account "check in"** — runs that one account only, for when a badge looks wrong

Both are idempotent: pressing them after today's claim just answers "already checked in today".

**Rapid clicking is safe.** A burst of clicks is collapsed into the run that is already
happening rather than fanned out: the browser keeps the in-flight request in a
`pendingCheckin` ref and hands it to every later click, and the host holds one process-wide
`sweepOnce` promise shared with the timer. Measured: 8 simultaneous clicks against a
4-account archive produced **4 upstream calls**, not 32.

### Passive reclaim

A cooldown expiring only makes an account *eligible* again — it does not move the selection back. Every minute the plugin checks whether the current account is still the best healthy one and switches back if not.

Three guards:

- a hand-picked account is held for 24 hours (see below), so a manual choice is not undone within the minute
- the current account still cooling **for the routed model** → skip (let the rotation own it);
  a limit on some *other* model does not hold the sweep back
- an Agent is mid-turn → skip (never interrupt work in progress)

### The manual-selection hold

**After you click "use this account", the plugin will not switch away from it for 24 hours.**

Why: the reclaim sweep orders accounts by longest-lived refresh token. If the account
you picked by hand is not the longest-lived one, the next sweep (≤60 s) would simply
put it back — which looks like "I picked 66ce and a moment later it jumped back to b058".

The hold blocks **passive reclaim only**, never **quota rotation**:

| During the hold | Behaviour |
|---|---|
| the sweep wants to return to a longer-lived account | ⏸ stays put |
| the current account hits a 429 / 402 | ✅ rotates and retries as usual |

In other words, **only a quota failure moves the selection during those 24 hours**. Once
the hold expires, reclaim resumes normally. The panel shows "hand-picked, held until …"
at the top, and the tag disappears on its own.

The switch's origin is recorded in the state file as `selected.source` (`user` / `auto`)
and `selected.holdUntilMs`.

### Two surfaces

Both read the same data:

| Where | What |
|---|---|
| **Plugin settings page** | full list, account details, cooldown state, check-in state, auto-rotate and check-in switches |
| **Bottom-right floating button** | quick switch popover |

**Plugin settings page** (sidebar → Plugins → `dsh-workbuddy-switcher`): every account shows its region, cooldown countdown, check-in badge and refresh-token expiry, with a small "clear" button directly behind each cooldown countdown, and the two switches at the bottom.

![Plugin settings page](docs/plugin-page.png)

**Floating button** (bottom-right by default): switch without leaving the conversation; the popover carries the same cooldown state and import action, and each cooldown badge is followed by its own small "clear" button. Drag it with a mouse or touch; its position is saved in the current browser and kept within the viewport on resize. Clicking or pressing Enter / Space still toggles the popover.

![Bottom-right floating button](docs/quick-switch.png)

In both shots `4dba68a4` is cooling ("冷却至 10/19 09:56") — the state left behind after the plugin rotated away from it when its quota ran out — while `128a8f9c` is the account in use.

**Daily check-in**: the header shows `check-in 4/4` for the current day, and every row carries its own state badge — `already +100 today · streak 12` means today's credits are in.

![Daily check-in](docs/checkin.png)

All four states of one day are visible there: already collected (streak 12 / streak 1), the account in
use, and one login that simultaneously carries a model-scoped cooldown
(`deepseek-v4.1-flash`, cooling until 10/19 09:56) yet still checked in fine — **cooldowns and
check-in do not interfere**.

## Install

### Requirements

- DSH `0.2.1-rc.2` or newer
- at least one WorkBuddy account signed in on this machine

### One-line install (recommended)

Hand the line below to the Agent already running on this machine (this DSH session is enough): it installs both plugins if missing, updates them if they are not current, and treats the dependency `dsh-workbuddy-connect` the same way.

```text
Install the dsh-workbuddy-switcher plugin (https://github.com/ddGuo/dsh-workbuddy-switcher): install it if missing, update it if it is not the latest, and do the same for the plugin it depends on, dsh-workbuddy-connect (https://github.com/corrinehu/dsh-workbuddy-connect). When done, remind me to fully quit and relaunch DSH.
```

Or run the equivalent command yourself — **re-running it is the update**, pinned to the current release:

```powershell
dsh plugin --profile desktop add "dsh-workbuddy-connect@^0.7.8" "git+https://github.com/ddGuo/dsh-workbuddy-switcher.git#v0.2.4" --config.strict-dep-builds=false
```

To follow the trunk instead (every `add` pulls the newest commit):

```powershell
dsh plugin --profile desktop add "dsh-workbuddy-connect@^0.7.8" "git+https://github.com/ddGuo/dsh-workbuddy-switcher.git" --config.strict-dep-builds=false
```

> - The `#v0.2.4` above is a **fixed release tag** and never drifts; drop it to follow the newest commit on `main`. Use tags for a settled install, `main` while developing.
> - `^0.7.8` rather than `@latest`: on mirrors the `latest` tag can still point at an old build (it resolved to 0.7.7 here and was rejected by the runtime's compatibility check).
> - If this plugin is already installed from a `file:` path, this command switches it to the git source (`- dsh-workbuddy-switcher` / `+ dsh-workbuddy-switcher 0.2.4` in the run above); to stay on your local checkout, use the local-source command below instead.
> - Re-`add`ing the **same** `file:` path only prints `Already up to date` — edited sources are not copied over.

### dsh-workbuddy-connect must be installed separately

This plugin does **not** pull `dsh-workbuddy-connect` in. That package is a `peerDependency`, and DSH profiles set `autoInstallPeers: false`, so installing this plugin installs only itself (measured: `Packages: +1`).

Declaring it as a hard dependency would drag in **87 packages**, and could produce two `dsh-workbuddy-connect` instances — one at the profile root, one inside this plugin's `node_modules`. The two would read different `process.env` objects, which breaks switching. Leaving it out is deliberate, and it is why the command above names both packages.

Installing from local sources (while hacking on the plugin):

```powershell
dsh plugin --profile desktop add "file:E:\dsh\dsh-workbuddy-switcher"
```

> **Note**: a `file:` install **copies** rather than symlinks, and a repeated `add` is judged `Already up to date`. Either `remove` + `add`, or re-sync directly:
>
> ```powershell
> Copy-Item "E:\dsh\dsh-workbuddy-switcher\lib\*" `
>   "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-workbuddy-switcher\lib\" -Force
> ```

### Restart

Host-side pieces (the `agent/request-error` listener and the reclaim timer) register **only at startup**, so a full quit and relaunch is required.

## Usage

### Add an account

1. Sign in to the target account in the WorkBuddy desktop app
2. In DSH: sidebar → Plugins → `dsh-workbuddy-switcher`
3. Click "Import current account"

A `<uid>.json` appears in the archive directory.

### Switch accounts

Click "Switch to this account" in the card, or use the floating button. It takes effect within ~30 seconds (the credential poll interval).

### Auto-rotate

On by default. The switch sits at the bottom of the card: **"Rotate when quota runs out"**. Turn it off to surface every quota error instead.

### Clear a cooldown manually

If an account is still marked as cooling but you know its quota is back, click the **"clear" chip sitting right after that cooldown badge**.

Every cooldown is one badge-plus-chip group, and the chip clears only the badge to its left.
The two render as an unbreakable inline group, so a wrapping row can never separate them:

- **account scope** — the badge reads "account quota, cooling until …"; hovering the chip
  shows the recorded cooldown reason (or a generic hint when none was recorded), and clicking
  it drops the whole account's cooldown
- **model scope** — the badge reads "model-name, cooling until …"; the chip drops that one
  model only, leaving every other cooldown on the same login intact, and its tooltip says
  just that: this model is limited, the rest of the account still works

The chip always reads "clear"; its scope is carried by which badge it sits behind, with the
accessible name spelling that scope out (`解除冷却：账号额度` for the account,
`解除该模型冷却：<model>` for a model) and the tooltip explaining it on hover. That fixes a
real problem: with two model-scoped cooldowns on one account, the earlier UI rendered two
identical "clear this model's cooldown" buttons side by side in the action bar, and nothing
said which model a click would unbench. No clear button is rendered in the action bar any
more — the bottom of the card holds only "Switch to this account", "Delete" and "Check in".

![cooldown buttons, before and after](docs/cooldown-clear.png)

Before (top): the account-wide and two model-scoped cooldowns sat in the name row while their
clear buttons lived down in the action bar, rendering as two identical "clear this model's
cooldown" buttons. After (bottom): every cooldown badge is followed immediately by its own
compact "clear" chip, and the action bar keeps only "Delete" and "Check in".

### Sync to another machine

On the source machine:

1. Click "Export credentials"
2. The browser downloads `workbuddy-accounts-<timestamp>.json`

On the target machine:

1. Click "Import credentials" and pick that file
2. The panel reports "added N, refreshed M, kept K local"

A bundle is roughly 2.4 KB per account (3 accounts ≈ 7 KB). Delete the file once both machines are synced.

## How it works

### Switching

`dsh-workbuddy-connect` resolves credentials as "configured `authFile` → environment variable → platform default", and it re-reads `process.env` on **every** resolution. So a switch is just:

```js
process.env.WORKBUDDY_AUTH_FILE = '/path/to/archive.json'
```

Its next credential poll (≤30 s) picks up the new account — no restart, no config edit.

### Archive format

Archives must use the **desktop shape** (`{auth, account}`), not the plugin's own-copy shape (`{version, credential}`):

```json
{
  "auth": {
    "accessToken": "...",
    "refreshToken": "...",
    "expiresAt": 1794728770,
    "domain": "www.workbuddy.cn",
    "refreshExpiresAt": 1794901570
  },
  "account": { "uid": "697af213-..." }
}
```

**Why**: a file named by `authFile` is parsed by `parseWorkBuddyAuth`, which only understands the desktop shape. Writing the own-copy shape makes the plugin read `undefined` and hide the entire model group — a silent failure with no error.

### The rotation hook

DSH's `agent/request-error` is a waterfall:

```js
const action = await this.dispatch.waterfall('agent/request-error', {
  turn, step, provider, failure, retryPolicy, signal,
}, () => Promise.resolve(undefined));

if (action?.kind !== 'retry') throw new LlmError(...);  // no retry → surface
continue;                                               // retry the step
```

- the listener registered first runs **outermost** (`prepend: true`)
- a listener that does not call `next()` **vetoes the rest of the chain**, so `dsh-llm-retry` never sees the failure and cannot waste retries on the exhausted account
- returning `{kind: 'retry'}` re-runs the step

The plugin uses exactly these three properties to hide the switch.

### Parsing the reset instant

Upstream messages look like:

```
您的使用量已超出频率限制，将在 2026-10-19 09:56:23 UTC+8 重置
```

The timestamp is interpreted as **UTC+8** (the upstream always uses that zone), so a machine in another time zone does not bench the account for hours too long:

```js
Date.UTC(y, m - 1, d, h, min, s) - 8 * 3600 * 1000
```

## Data files

| Path | Contents |
|---|---|
| `~/.dsh/workbuddy-accounts/<uid>.json` | credential archive (**plaintext**) |
| `~/.dsh/workbuddy-accounts/<uid>.json.bak` | automatic backup taken before a check-in token refresh (for a manual rollback) |
| `~/.dsh/workbuddy-switcher.json` | current selection + cooldown table + check-in records |

A cooldown entry takes one of two shapes, depending on its scope:

```json
{
  "cooldowns": {
    "alice.json": { "untilMs": 1792374983000, "reason": "…", "strikes": 1 },
    "bob.json": { "models": { "claude-sonnet-4-5": { "untilMs": 1792374983000, "reason": "…" } } }
  }
}
```

- `alice` is an **account-level** cooldown (credits gone): no model works
- `bob` is limited on **one model** only; the rest of that login stays in rotation

The older flat shape is still read: an entry with no `models` field means the whole account.

The selection and its hold live in the same file:

```json
{
  "selected": {
    "file": "128a8f9c-….json",
    "source": "user",
    "selectedAt": 1792327652403,
    "holdUntilMs": 1792414052403
  }
}
```

- `source` — `user` (clicked in the panel) or `auto` (rotation / reclaim)
- `holdUntilMs` — present for `user` only; passive reclaim is suspended until then

Deleting `holdUntilMs`, or moving it into the past, returns that account to automatic
scheduling immediately.

Check-in records live in the same file, keyed by archive name:

```json
{
  "checkin": {
    "enabled": true,
    "lastSweepAt": 1792329408764,
    "accounts": {
      "128a8f9c-….json": {
        "result": "already",
        "day": "2026-10-18",
        "credit": 100,
        "streakDays": 12,
        "totalCredits": 1200,
        "endTime": "2026-10-31 23:59:59",
        "attempts": 1,
        "atMs": 1792329408070,
        "nextAttemptMs": 1792333008070
      }
    }
  }
}
```

- `day` is the **server's** date, not the host's — changing the system clock cannot make it claim twice
- `result` is one of `claimed` / `already` / `inactive` / `region` / `pending` / `auth` / `network` / `unknown`
- `nextAttemptMs` exists only for `network` / `unknown`, and suppresses retries until it passes
- deleting `checkin.accounts` resets today's memory; the next pass re-queries every account

### Security

Archives hold **plaintext accessToken / refreshToken**.

- do not commit them
- do not put them on a shared drive
- do not keep only an unencrypted backup

> Check-in sends the access token to `www.codebuddy.cn` and `copilot.tencent.com` — the same
> hosts the plugin already uses for the balance read, so no third party is added.

> On "can I force a signed-out device off after a leak?": **no**. WorkBuddy only supports account-level revocation (change the password); there is no per-session or per-device kill switch. Verified experimentally: signing out in the desktop app does not revoke issued tokens, `sid` is unchanged, and tokens slide forward indefinitely. Keeping the archive file safe is the only defence.

## Configuration

| Variable | Effect |
|---|---|
| `WORKBUDDY_SWITCHER_DIR` | override the archive directory |
| `WORKBUDDY_ELECTRON_BIN` | path to the WorkBuddy executable (needed to decrypt credentials) |

## Troubleshooting

### The model list did not change after switching

`dsh-workbuddy-connect` polls credentials every 30 seconds. The plugin triggers a refresh itself, but if that fails, wait it out or click "Refresh models".

### The model group disappeared

Almost certainly a wrong archive shape. The top-level keys must be `auth` / `account`; `version` / `credential` means an old file, which is migrated automatically on the next DSH start.

### Auto-rotation does nothing

1. confirm DSH was restarted (host code loads only at startup)
2. confirm "Rotate when quota runs out" is checked
3. confirm an account is *selected* rather than "follow the client" — rotation is skipped in follow mode, because the app's credential is not in the archive

### Stuck in cooldown though the quota is back

Click the "clear" chip **immediately to the right of that cooldown badge**. Badge and chip are one unbreakable inline group, so a wrapped row will not put them on separate lines.

When the badge names a **model** (say "claude-sonnet-4-5 cooling until …"), that chip drops only that model's limit, leaving any other cooldown on the same login in place; when the badge says "account quota, cooling until …", the chip is the one that clears the whole account.

### Telling an exhausted login from a throttled model

Look at the badge:

- **"account quota, cooling until …"** → the whole login is limited; only switching accounts helps
- **"model-name, cooling until …"** → that model alone is limited; another model on the same login still works

A dimmed badge marks a cooldown that does not affect the currently routed model.

The chip behind a badge touches that badge's scope and nothing else: an account-scoped chip
clears the account, a model-scoped chip clears that model. When both are live the card shows
two groups — one click each, which is exactly why the buttons moved out of the action bar and
next to the badges they clear.

### A manual switch jumped back on its own

It should not within 24 hours. If it does, the hold is not in effect:

1. check for the "hand-picked, held until …" tag at the top of the panel — no tag means the switch was not recorded as manual
2. check `selected.source` is `user` and `selected.holdUntilMs` is in the future in the state file
3. if the switch came from **quota rotation**, that is expected — the hold does not block it

### Hand an account back to automatic scheduling right away

Delete `selected.holdUntilMs` from the state file, or set it to a past instant.

### A check-in did not land

Read the badge first:

| Badge | What to do |
|---|---|
| `already +100 today` | nothing; come back tomorrow |
| `check-in failed · token rejected` | that account needs a fresh sign-in (sign in in the app, then "Import current account") |
| `check-in failed · network` | the next pass retries in 10 minutes; the per-account button retries immediately |
| `activity closed` | the season ended or has not started; the badge shows the closing date |
| no badge at all | nothing has swept yet. Press "All accounts"; `checkin.lastSweepAt` updates |

If nothing at all happens, confirm DSH was restarted — the host-side timers are only
registered at startup.

### Does rapid clicking double-claim or hang?

No. Both the browser and the host collapse a burst into one pass (see "Manual check-in"),
and credits are de-duplicated per day upstream, so a repeat claim only answers
"already checked in today".

> v0.2.0 and earlier had a real defect here: every state write shared one fixed temp
> filename (`workbuddy-switcher.json.tmp`), so concurrent writers raced and the second
> `rename` failed with `ENOENT` — a click could return a 500 or lose state. Since v0.2.1
> all writes go through one serialising lock and use a unique temp name per write. Measured
> on the old discipline with 50 concurrent writers: 46 failed writes, 1 of 50 keys survived;
> the same 18-request burst against the real route now succeeds 18/18.

### Did the check-in log my account out?

No. It does exactly three things: read the status, claim, and — on a `401` — refresh the
token once.

The refresh rotates the refresh token, so writing it back is load-bearing. The plugin
re-reads the file first and abandons the write when its access token is no longer the one
the refresh started from, so a concurrent writer wins instead of being clobbered. A copy of
the pre-refresh archive is left at `<uid>.json.bak` for a manual rollback.

## Limitations

- **Rotation only covers archived accounts.** In "follow the client" mode the plugin will not switch away, since that would silently change accounts.
- **Remaining quota is unknowable.** A `429` means "limited right now", not "how much is left". Rotation ordering uses refresh-token lifetime, not balance.
- **The limit's scope is inferred.** The upstream may answer "this model is throttled" and "the balance is gone" with the same 429. The plugin separates them by whether the message carries credit wording: with it the account is benched, without it only the model is. When the model cannot be determined it falls back to the account scope (conservative).
- **A manual choice gives up a small optimisation.** For 24 hours the plugin will not return to the account with the longer-lived refresh token; that is deliberate — your choice outranks that optimisation.
- **Archives are plaintext.** See the security note above.
- **The check-in endpoint is private.** It was reverse-engineered from the desktop client, so a WorkBuddy release can break it; a break shows up as `check-in failed · error` and affects nothing else. This plugin claims the check-in itself (100 credits a day) and deliberately leaves the growth-centre rewards alone.
- **The check-in day is the server's.** The host's time zone does not affect it, which also means "today" follows the UTC+8 calendar while travelling.

## License

MIT. See [LICENSE](./LICENSE).

## Related

- [`dsh-workbuddy-connect`](https://github.com/corrinehu/dsh-workbuddy-connect) — brings WorkBuddy models into DSH (required in practice)
