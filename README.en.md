# DSH WorkBuddy Switcher

English | [中文](./README.md)

Manage a pool of WorkBuddy accounts inside DeepSeek Harness and switch between them at will — with **automatic rotation when an account runs out of quota**.

> A companion plugin for [`dsh-workbuddy-connect`](https://github.com/corrinehu/dsh-workbuddy-connect). That plugin brings WorkBuddy models into DSH; this one schedules work across multiple accounts.

---

## The problem

`dsh-workbuddy-connect` uses one account at a time. Switching means either signing in again inside the WorkBuddy desktop app or hand-editing a config file. WorkBuddy also has a daily quota, so once an account is exhausted it is unusable for the rest of the day.

This plugin does three things:

1. **Account archive** — stores each account's credentials locally, so switching no longer requires the desktop app
2. **One-click switching** — from the plugin settings card or a floating bottom-right button; the model list refreshes immediately
3. **Automatic rotation** — on a quota failure it moves to the next account and retries, so the interruption is invisible

## Features

### Archive and switching

- Archive directory: `~/.dsh/workbuddy-accounts/`, one JSON per account
- "Import current account" stores whichever account the WorkBuddy app is signed in to
- Duplicate copies of the same account are collapsed to the canonical file
- The panel polls every 10 seconds, so a freshly signed-in account appears by itself

### Automatic rotation

| Upstream result | Action | Why |
|---|---|---|
| `429 soft_rate` | ✅ rotate and retry | a different account recovers instantly |
| `402 hard_credit` | ✅ rotate and retry | same |
| `401` / `12153` | ❌ no rotation | another account does not fix an expired session |
| Content rejection | ❌ no rotation | unrelated to the account |
| `5xx` | ❌ no rotation | left to `dsh-llm-retry` backoff |

Cooldown length:

- upstream message carries a reset instant → **cooldown ends exactly then**
- no reset instant → 10 minutes for the first two strikes, 24 hours from the third

Cooldowns are persisted, survive restarts, expire on their own, and a once-a-minute sweep **switches back** to a better account afterwards.

### Passive reclaim

A cooldown expiring only makes an account *eligible* again — it does not move the selection back. Every minute the plugin checks whether the current account is still the best healthy one and switches back if not.

Two guards:

- current account still cooling → skip (let the rotation own it)
- an Agent is mid-turn → skip (never interrupt work in progress)

### Two surfaces

Both read the same data:

| Where | What |
|---|---|
| **Plugin settings page** | full list, account details, cooldown state, auto-rotate switch |
| **Bottom-right floating button** | quick switch popover |

## Install

### Requirements

- DSH `0.2.1-rc.2` or newer
- `dsh-workbuddy-connect@0.7.8` or newer (optional, but without it there is nothing to switch)
- at least one WorkBuddy account signed in on this machine

### Install

```powershell
dsh plugin --profile desktop add "file:E:\dsh\dsh-workbuddy-switcher"
```

Or from git:

```powershell
dsh plugin --profile desktop add "git+https://github.com/<you>/dsh-workbuddy-switcher.git"
```

> **Note**: a `file:` install **copies** rather than symlinks. After editing the sources, re-sync:
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

If an account is still marked as cooling but you know its quota is back, click "Clear cooldown".

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
| `~/.dsh/workbuddy-switcher.json` | current selection + cooldown table |

### Security

Archives hold **plaintext accessToken / refreshToken**.

- do not commit them
- do not put them on a shared drive
- do not keep only an unencrypted backup

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

Click "Clear cooldown".

## Limitations

- **Rotation only covers archived accounts.** In "follow the client" mode the plugin will not switch away, since that would silently change accounts.
- **Remaining quota is unknowable.** A `429` means "limited right now", not "how much is left". Rotation ordering uses refresh-token lifetime, not balance.
- **Archives are plaintext.** See the security note above.

## License

MIT. See [LICENSE](./LICENSE).

## Related

- [`dsh-workbuddy-connect`](https://github.com/corrinehu/dsh-workbuddy-connect) — brings WorkBuddy models into DSH (required in practice)
