/**
 * dsh-workbuddy-switcher — host half.
 *
 * Keeps a directory of WorkBuddy accounts and repoints `dsh-workbuddy-connect`
 * at the selected one by setting `WORKBUDDY_AUTH_FILE` / `WORKBUDDY_AI_AUTH_FILE`
 * in this process's environment. The credential store re-reads
 * `process.env[envVar]` on every resolution, so a switch lands on the next
 * sweep (≤30 s) with no restart and no config edit.
 *
 * Archives are stored in the **desktop credential shape** (`{auth, account}`),
 * because an `authFile` override is parsed by the plugin's desktop parser
 * (`parseWorkBuddyAuth`), not by its own-copy parser. Writing the own-copy
 * shape (`{version, credential}`) there makes the plugin read `undefined` and
 * treat the variant as signed out — which hides the whole model group.
 *
 * It never writes the WorkBuddy desktop app's own auth file.
 *
 * ## Automatic rotation
 *
 * When `dsh-workbuddy-connect` reports a quota failure (HTTP 429 `soft_rate`, or
 * HTTP 402 `hard_credit`) the account is unusable for a while, but the request
 * that hit it has already failed. DSH exposes a waterfall hook for exactly that
 * moment — `agent/request-error` — whose payload carries the provider, the
 * failure (`code` / `message` / `status`) and the resolved retry policy. This
 * plugin listens there: it marks the failing account as cooled down, points the
 * provider at the next healthy archive, and asks the agent to retry the step.
 * The retry is what makes the switch seamless — without it the user would still
 * see the 429.
 *
 * Rotation is deliberately conservative:
 *
 * - only quota failures rotate; auth problems and content rejections do not,
 *   because a different account does not fix them;
 * - a cooldown is recorded against what it actually limits. WorkBuddy answers a
 *   per-model rate limit with the same `429 soft_rate` it uses for a spent
 *   account, so a `429` that named one model only benches that model, while a
 *   `402 hard_credit` (and anything the message calls a credit exhaustion)
 *   benches the whole account. Marking a whole account dead because one model
 *   was hot throws away a login that still works for every other model;
 * - a cooled account is skipped until its reset time, and every account is
 *   cooled by some amount so a permanently dead one cannot be retried in a loop;
 * - the rotation is disabled with one switch, and the previous selection is
 *   restored from the state file on the next start.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { canonicalFromDocument, isGlobalDomain, toDesktopDocument } from './format.js';
import { checkinApplicable, collectDailyCheckin, shanghaiDay } from './checkin.js';

const CN_ENV = 'WORKBUDDY_AUTH_FILE';
const AI_ENV = 'WORKBUDDY_AI_AUTH_FILE';
const DEFAULT_DIR = join(homedir(), '.dsh', 'workbuddy-accounts');
const STATE_FILE = join(homedir(), '.dsh', 'workbuddy-switcher.json');

/** Consecutive quota failures before an account is benched for the rest of the day. */
const HARD_BENCH_AFTER = 3;
/** Fallback cooldown when the upstream gives no reset time (ms). */
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;
/** Successive claim attempts for one account before it waits for the next sweep. */
const CHECKIN_RETRY_BACKOFF_MS = [10 * 60 * 1000, 30 * 60 * 1000, 60 * 60 * 1000];
/** How often the check-in sweep runs. */
const CHECKIN_INTERVAL_MS = 30 * 60 * 1000;
/** A sweep gives up on its own after this long and leaves the rest to the next one. */
const CHECKIN_BUDGET_MS = 5 * 60 * 1000;
/** Delay before the startup catch-up pass, so boot stays quiet. */
const CHECKIN_STARTUP_DELAY_MS = 90 * 1000;
/**
 * How long a hand-picked account is protected from the reclaim sweep (ms).
 *
 * The sweep exists to undo *rotation's* choices once a cooldown expires; it must
 * not keep undoing the user's. A day is long enough to cover a working session
 * and short enough that the pool goes back to managing itself on its own.
 * Quota rotation ignores the hold: an account that is actually limited cannot
 * serve the request, whatever the user asked for earlier.
 */
const MANUAL_HOLD_MS = 24 * 3600 * 1000;

/** Upstream wording that means "the credits are gone", not "this model is hot". */
const CREDIT_EXHAUSTION =
  /hard_credit|积分不足|额度不足|余额不足|积分用完|额度用尽|没有积分|insufficient credit|no credit|out of credit|credit not enough|not enough credit|credit exhausted|quota exceeded|payment required/i;

/**
 * Whether a failure means "this account is out of quota right now" — as opposed
 * to "this one model is rate limited".
 *
 * The distinction is the whole point of model-scoped cooldowns. WorkBuddy
 * reports a per-model throttle with the very same `429 soft_rate` it uses for a
 * spent account, and `dsh-workbuddy-connect` maps both onto `RATE_LIMIT`, so the
 * DSH code alone cannot tell them apart. Two signals can:
 *
 * - a credit-exhaustion marker in the message ("积分不足" / "quota exceeded")
 *   is account-wide by definition, whatever status carried it;
 * - `402 hard_credit` is account-wide too, since that is what the upstream
 *   means by it.
 *
 * Everything else that lands here (`429 soft_rate` with no credit wording) is
 * treated as a per-model limit, which is the conservative reading for the
 * account: it keeps the login in rotation for every other model.
 *
 * @param failure - the `failure` object from `agent/request-error`.
 * @returns whether the whole account is exhausted rather than one model.
 */
function isAccountWideFailure(failure) {
  if (typeof failure !== 'object' || failure === null) return false;
  const code = typeof failure.code === 'string' ? failure.code : '';
  if (code === 'QUOTA_EXCEEDED' || code === 'hard_credit' || code === 'QUOTA') return true;
  const status = typeof failure.status === 'number' ? failure.status : undefined;
  if (status === 402) return true;
  const message = typeof failure.message === 'string' ? failure.message : '';
  if (message === '') return false;
  return CREDIT_EXHAUSTION.test(message);
}

/**
 * Whether a failure means "this account is out of quota right now".
 *
 * `dsh-workbuddy-connect` maps its own upstream classification onto DSH codes,
 * so both the DSH code and the raw upstream text have to be recognised.
 *
 * @param failure - the `failure` object from `agent/request-error`.
 * @returns whether another account could plausibly succeed instead.
 */
function isQuotaFailure(failure) {
  if (typeof failure !== 'object' || failure === null) return false;
  const code = typeof failure.code === 'string' ? failure.code : '';
  // RATE_LIMIT covers 429 soft_rate; QUOTA_EXCEEDED covers 402 hard_credit.
  if (code === 'RATE_LIMIT' || code === 'QUOTA_EXCEEDED' || code === 'QUOTA' || code === 'soft_rate' || code === 'hard_credit') {
    return true;
  }
  const message = typeof failure.message === 'string' ? failure.message : '';
  if (message === '') return false;
  return (
    /soft_rate|hard_credit|使用量已超出频率限制|积分不足|额度不足|余额不足|insufficient credit|quota exceeded/i.test(
      message,
    )
  );
}

/**
 * Read the reset instant the upstream embedded in its message, if any.
 *
 * WorkBuddy reports limits as `将在 2026-10-19 09:56:23 UTC+8 重置`. That string
 * is interpreted as CST (UTC+8) rather than the host zone: the upstream always
 * sends it in that zone, and reading it as local time on a machine set to
 * another zone would bench the account for hours too long.
 *
 * @param failure - the failing request's failure object.
 * @returns epoch milliseconds of the reset, or undefined when absent.
 */
function resetAtOf(failure) {
  const message = typeof failure?.message === 'string' ? failure.message : '';
  // Two spellings reach here: the full upstream sentence (`将在 … 重置`), and the
  // same instant with only its zone suffix when the shim truncated the body. The
  // timestamp itself is the reliable part, so accept either framing rather than
  // losing an exact reset instant to a missing word.
  const match =
    /将在\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(message) ??
    /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*UTC\+8/.exec(message);
  if (match === null) return undefined;
  const [, year, month, day, hour, minute, second] = match;
  const utcMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  return Number.isFinite(utcMs) ? utcMs - 8 * 3600 * 1000 : undefined;
}

function accountsDir() {
  const fromEnv = process.env['WORKBUDDY_SWITCHER_DIR'];
  return typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv.trim() : DEFAULT_DIR;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Read one archive file into the summary the UI renders. */
async function describeArchive(path) {
  const credential = canonicalFromDocument(await readJson(path));
  if (credential === undefined) return undefined;
  return {
    file: basename(path),
    uid: credential.uid,
    nickname: credential.nickname ?? '',
    domain: credential.domain,
    enterpriseId: credential.enterpriseId ?? '',
    region: isGlobalDomain(credential.domain) ? 'global' : 'cn',
    expiresAtMs: credential.expiresAtMs,
    refreshExpiresAtMs: credential.refreshExpiresAtMs ?? 0,
  };
}

async function listAccounts() {
  const dir = accountsDir();
  if (!existsSync(dir)) return [];
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const row = await describeArchive(join(dir, name));
    if (row !== undefined) rows.push(row);
  }
  rows.sort((a, b) => b.refreshExpiresAtMs - a.refreshExpiresAtMs);
  return dedupeByAccount(rows);
}

/**
 * Collapse several archives of one account into the one entry the UI shows.
 *
 * Copies accumulate on purpose — the capture tool keeps a baseline beside the
 * live file — but they are the same account, so listing each of them would
 * offer a switch that changes nothing. The file named after the account's uid
 * wins (that is the shape the capture tool writes); otherwise the freshest
 * expiry wins.
 *
 * @param rows - one summary per archive file.
 * @returns one summary per account, in the input order.
 */
function dedupeByAccount(rows) {
  const best = new Map();
  for (const row of rows) {
    const key = `${row.uid}:${row.enterpriseId}`;
    const previous = best.get(key);
    if (previous === undefined || prefersOver(row, previous)) best.set(key, row);
  }
  return [...best.values()].sort((a, b) => b.refreshExpiresAtMs - a.refreshExpiresAtMs);
}

/**
 * Whether `candidate` should represent an account instead of `current`.
 *
 * @param candidate - summary being considered.
 * @param current - summary already chosen for the same account.
 * @returns true when the candidate is the canonical file or outlives the other.
 */
function prefersOver(candidate, current) {
  const canonical = (row) =>
    row.uid !== '' && basename(row.file, '.json') === row.uid;
  if (canonical(candidate) !== canonical(current)) return canonical(candidate);
  return candidate.refreshExpiresAtMs > current.refreshExpiresAtMs;
}

/**
 * Rewrite archives saved in the plugin's own-copy shape into the desktop shape
 * an `authFile` must carry. Idempotent; a file already in desktop shape is left
 * untouched.
 */
async function migrateArchives() {
  const dir = accountsDir();
  if (!existsSync(dir)) return [];
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const migrated = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    const document = await readJson(path);
    if (document === undefined || typeof document !== 'object' || document === null) continue;
    const alreadyDesktop =
      typeof document.auth === 'object' && document.auth !== null && 'accessToken' in document.auth;
    if (alreadyDesktop) continue;
    const credential = canonicalFromDocument(document);
    if (credential === undefined) continue;
    await writeFile(path, `${JSON.stringify(toDesktopDocument(credential), null, 2)}\n`, {
      mode: 384,
    });
    migrated.push(name);
  }
  return migrated;
}

/**
 * Serialize every state write through one chain.
 *
 * The state file has several independent writers — the check-in sweep, quota
 * rotation, the reclaim sweep and every panel action — and they all do
 * read-modify-write. Two hazards follow, and both showed up the moment the panel
 * was clicked repeatedly:
 *
 * - a **shared temp filename** meant two writers opened the same `.tmp`; the
 *   first `rename` consumed it and the second failed with ENOENT, which surfaced
 *   as an HTTP 500 on a click that should have been harmless;
 * - a **lost update**: B reads, A reads, A writes, B writes — A's record is gone.
 *
 * A promise chain fixes the first outright and narrows the second to the gap
 * between a caller's own read and its queued write, which is what
 * {@link recordCheckin} re-reads inside the lock to close.
 */
let writeChain = Promise.resolve();

/**
 * Queue one exclusive state-file operation.
 *
 * @param task - callback receiving nothing, resolving when the write is done.
 * @returns the task's result.
 */
function withStateLock(task) {
  const run = writeChain.then(task, task);
  // Keep the chain alive whatever the task did; the caller still sees its error.
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function readState() {
  const state = await readJson(STATE_FILE);
  return typeof state === 'object' && state !== null ? state : {};
}

async function writeState(next) {
  await mkdir(join(homedir(), '.dsh'), { recursive: true });
  // Unique per write, so a queued writer can never collide with another one even
  // if the lock is ever bypassed.
  const temporary = `${STATE_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 384 });
  await rename(temporary, STATE_FILE);
}

/**
 * Read, change and write the state in one queued step.
 *
 * @param mutate - receives the parsed state; may mutate it in place.
 * @returns whatever `mutate` returned.
 */
function updateState(mutate) {
  return withStateLock(async () => {
    const state = await readState();
    const result = await mutate(state);
    await writeState(state);
    return result;
  });
}

/** The record kept for one archive, or an empty one. */
function checkinRecord(state, file) {
  const all = state.checkin?.accounts;
  if (typeof all !== 'object' || all === null) return {};
  const entry = all[file];
  return typeof entry === 'object' && entry !== null ? entry : {};
}

/** Whether an account's credits for today are settled, so it needs no request. */
function checkinDone(record, day) {
  return (
    record.day === day && (record.result === 'claimed' || record.result === 'already')
  );
}

/** Whether the record says the whole activity is closed, so it needs no request. */
function checkinClosed(record, day) {
  return record.day === day && record.result === 'inactive';
}

/**
 * Merge one account's check-in result into the state file.
 *
 * The read and the write happen inside the state lock, so a record cannot be
 * lost to a rotation or panel write that lands between them.
 *
 * @param file - archive the record belongs to.
 * @param result - the record to store.
 */
async function recordCheckin(file, result) {
  await updateState((state) => {
    const accounts =
      typeof state.checkin?.accounts === 'object' && state.checkin.accounts !== null
        ? { ...state.checkin.accounts }
        : {};
    accounts[file] = result;
    state.checkin = { ...(state.checkin ?? {}), accounts };
  });
}

/**
 * A failure worth retrying today, with the delay before the next attempt.
 *
 * `auth` is deliberately excluded: a rejected session does not heal by waiting,
 * and retrying it every sweep would hammer a dead login eight times an hour.
 *
 * @param result - a check-in result record.
 * @returns epoch milliseconds of the next allowed attempt, or undefined.
 */
function checkinRetryAt(result) {
  if (result.result !== 'network' && result.result !== 'unknown') return undefined;
  const attempts = typeof result.attempts === 'number' ? result.attempts : 1;
  const backoff = CHECKIN_RETRY_BACKOFF_MS[Math.min(attempts - 1, CHECKIN_RETRY_BACKOFF_MS.length - 1)];
  return Date.now() + backoff;
}

/**
 * One check-in sweep per process at a time.
 *
 * The panel's buttons are cheap to press and the sweep is not cheap to run: a
 * full pass is one request per account with a 15-second timeout each, so a burst
 * of clicks would otherwise start a burst of independent sweeps, each holding
 * its own sockets and each re-reading and rewriting the shared state file. Even
 * a single account has a cost — the claim endpoint is idempotent, but N clicks
 * still mean N round trips to one upstream from one machine.
 *
 * The second caller does not queue: it gets the in-flight promise, so repeated
 * clicks collapse into the run that is already happening rather than fanning out
 * behind it. That is also the honest answer for the user — the work they asked
 * for is already in progress, and its result is what they will see.
 */
let checkinInFlight;

/**
 * Collect points, at most once at a time.
 *
 * @param ctx - host context, for logging.
 * @param options - see {@link runCheckinSweep}.
 * @returns the running (or newly started) sweep's result.
 */
function sweepOnce(ctx, options) {
  if (checkinInFlight !== undefined) return checkinInFlight;
  checkinInFlight = runCheckinSweep(ctx, options).finally(() => {
    checkinInFlight = undefined;
  });
  return checkinInFlight;
}

/**
 * Run one check-in sweep over the archive.
 *
 * Accounts are visited one at a time. They are four small requests against one
 * upstream, so serialising costs seconds and removes any question about rate
 * limits or about two sweeps racing each other.
 *
 * Everything here is best-effort by construction: a sweep that throws must not
 * take down rotation or the reclaim timer with it, so failures are recorded per
 * account and the loop continues.
 *
 * @param ctx - host context, for logging.
 * @param options - `files` limits the sweep to those archives; `manual` bypasses
 *   both the feature switch and the "already done today" short-circuit.
 * @returns the day it ran for, and one record per visited archive.
 */
async function runCheckinSweep(ctx, options = {}) {
  const { files, manual = false } = options;
  const state = await readState();
  if (!manual && state.checkin?.enabled === false) return { skipped: 'disabled', results: {} };

  const day = shanghaiDay();
  const rows = await listAccounts();
  const targets = files === undefined ? rows : rows.filter((row) => files.includes(row.file));
  const deadline = Date.now() + CHECKIN_BUDGET_MS;
  const results = {};

  for (const row of targets) {
    if (Date.now() > deadline) {
      ctx.logger?.info?.('dsh-workbuddy-switcher: check-in budget spent; the rest waits for the next sweep');
      break;
    }
    const record = checkinRecord(await readState(), row.file);
    if (!manual) {
      if (checkinDone(record, day)) continue;
      if (checkinClosed(record, day)) continue;
      // Only a backoff recorded *for today* may delay today's pass: a retry
      // scheduled at 23:50 would otherwise hold the new day's claim until 00:50.
      const retryAt =
        record.day === day && typeof record.nextAttemptMs === 'number' ? record.nextAttemptMs : 0;
      if (retryAt > Date.now()) continue;
    }

    const path = join(accountsDir(), row.file);
    const credential = canonicalFromDocument(await readJson(path));
    if (credential === undefined) {
      results[row.file] = { result: 'unknown', day, reason: '存档无法解析' };
      continue;
    }
    if (!checkinApplicable(credential)) {
      results[row.file] = { result: 'region', day, reason: '国际版没有签到活动' };
      continue;
    }

    let next;
    try {
      next = await collectDailyCheckin(credential, { archivePath: path });
    } catch (error) {
      next = {
        result: 'unknown',
        day,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    const attempts = (typeof record.attempts === 'number' ? record.attempts : 0) + 1;
    const retryAt = checkinRetryAt({ ...next, attempts });
    const stored = {
      ...next,
      attempts,
      atMs: Date.now(),
      ...(retryAt === undefined ? {} : { nextAttemptMs: retryAt }),
    };
    results[row.file] = stored;
    await recordCheckin(row.file, stored).catch(() => undefined);

    if (next.result === 'claimed') {
      ctx.logger?.info?.(
        `dsh-workbuddy-switcher: check-in collected ${next.credit ?? 100} credits for ${row.uid.slice(0, 8)}` +
          (typeof next.streakDays === 'number' ? ` (streak ${next.streakDays})` : ''),
      );
    }
  }

  await updateState((state) => {
    state.checkin = { ...(state.checkin ?? {}), lastSweepAt: Date.now() };
  });

  return { day, results };
}

/** The account currently pointed at, resolved through the env the plugin emits. */
function activeSelection() {
  const cn = process.env[CN_ENV];
  const ai = process.env[AI_ENV];
  return {
    authFile: typeof cn === 'string' && cn !== '' ? cn : undefined,
    authFileAI: typeof ai === 'string' && ai !== '' ? ai : undefined,
  };
}

/**
 * Point the variant matching the archive's region at it, and clear the other.
 *
 * Setting both variables at once would hand the international variant a CN
 * credential, which the plugin rejects with `credential-region-mismatch`; only
 * the matching side is pointed at the file.
 *
 * `source` records who asked for the switch, because the passive reclaim sweep
 * must not undo a choice the user made by hand:
 *
 * - `'user'` — the panel. Starts a {@link MANUAL_HOLD_MS} window during which
 *   only a quota failure may move the selection;
 * - `'auto'` — rotation or reclaim. No hold, so the pool keeps managing itself.
 *
 * @param file - archive file to select, or null to hand control back to the app.
 * @param source - who initiated the switch; defaults to `'auto'`.
 */
async function selectAccount(file, source = 'auto') {
  const dir = accountsDir();
  if (file === null || file === undefined) {
    delete process.env[CN_ENV];
    delete process.env[AI_ENV];
    await updateState((state) => {
      delete state.selected;
    });
    return { selected: activeSelection() };
  }
  const row = await describeArchive(join(dir, file));
  if (row === undefined) throw new Error(`unknown account archive: ${file}`);
  const path = join(dir, file);
  if (row.region === 'global') {
    process.env[AI_ENV] = path;
    delete process.env[CN_ENV];
  } else {
    process.env[CN_ENV] = path;
    delete process.env[AI_ENV];
  }
  const selectedAt = Date.now();
  await updateState((state) => {
    state.selected = {
      file,
      uid: row.uid,
      domain: row.domain,
      region: row.region,
      selectedAt,
      source,
      // Only a hand-picked account is protected from the reclaim sweep; a
      // rotation's own choice must stay reclaimable or the pool would freeze on
      // whatever account happened to be second-best.
      ...(source === 'user' ? { holdUntilMs: selectedAt + MANUAL_HOLD_MS } : {}),
    };
  });
  return { selected: activeSelection() };
}

/**
 * Cooldown bookkeeping.
 *
 * An entry is keyed by archive file and scoped to either the whole account or a
 * single model:
 *
 * ```json
 * { "alice.json": { "untilMs": …, "reason": …, "strikes": 1 } }
 * { "alice.json": { "models": { "claude-sonnet": { "untilMs": …, "reason": … } } } }
 * ```
 *
 * A flat entry (no `models`) cools the whole account; a `models` map cools only
 * the models it names, and the account itself stays eligible for everything
 * else. This is the difference between "this login has no credits left" and
 * "this login was refreshing one model too fast" — the upstream returns `429`
 * for both, and benching the account for the second throws away a working login.
 *
 * Persisted next to the selection so a DSH restart neither forgets that an
 * account is out of quota nor retries it immediately. Entries expire on their
 * own: a cooled account re-enters the rotation as soon as its window passes.
 *
 * @returns the live cooldown map, pruned of expired entries and empty scopes.
 */
async function cooldownsNow() {
  const state = await readState();
  const raw = typeof state.cooldowns === 'object' && state.cooldowns !== null ? state.cooldowns : {};
  const now = Date.now();
  const live = {};
  for (const [file, entry] of Object.entries(raw)) {
    const pruned = pruneEntry(entry, now);
    if (pruned !== undefined) live[file] = pruned;
  }
  return live;
}

/**
 * Drop the expired parts of one cooldown entry.
 *
 * @param entry - stored entry, in either shape.
 * @param now - current epoch milliseconds.
 * @returns the entry with only live scopes, or undefined when nothing is left.
 */
function pruneEntry(entry, now) {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const models = typeof entry.models === 'object' && entry.models !== null ? entry.models : undefined;
  if (models === undefined) {
    return typeof entry.untilMs === 'number' && entry.untilMs > now ? entry : undefined;
  }
  const liveModels = {};
  for (const [model, scope] of Object.entries(models)) {
    if (typeof scope !== 'object' || scope === null) continue;
    if (typeof scope.untilMs === 'number' && scope.untilMs > now) liveModels[model] = scope;
  }
  const accountCooling =
    typeof entry.untilMs === 'number' && entry.untilMs > now ? entry : undefined;
  if (Object.keys(liveModels).length === 0) return accountCooling;
  if (accountCooling !== undefined) return { ...accountCooling, models: liveModels };
  return { models: liveModels };
}

/**
 * The cooldown still blocking `file` for `model`, if any.
 *
 * A whole-account cooldown blocks every model; a model-scoped one blocks only
 * the model it names. An unknown model falls back to "any live scope blocks",
 * because a cooldown that cannot be attributed to a narrower scope must be
 * assumed to cover the request about to be made — guessing "not this model"
 * would send the request straight back into the limit.
 *
 * The returned record is normalized (`model: null` means the whole account), so
 * callers never have to know which of the two stored shapes they are holding.
 *
 * @param entry - live cooldown entry for the account.
 * @param model - the model the next request would use, when known.
 * @returns the blocking scope, or undefined when the request may go through.
 */
function blockingScope(entry, model) {
  if (entry === undefined || entry === null) return undefined;
  const scopes = cooldownScopes(entry);
  if (scopes.length === 0) return undefined;
  const accountWide = scopes.find((scope) => scope.model === null);
  // An exhausted login blocks everything, whatever model was asked for.
  if (accountWide !== undefined) return accountWide;
  if (model === undefined || model === '') return scopes[0];
  return scopes.find((scope) => scope.model === model);
}

/**
 * Flatten one entry into the per-scope list both the UI and the sweep reason on.
 *
 * @param entry - live cooldown entry.
 * @returns one record per live scope; `model: null` means the whole account.
 */
function cooldownScopes(entry) {
  if (entry === undefined || entry === null) return [];
  const scopes = [];
  if (typeof entry.untilMs === 'number') {
    scopes.push({
      model: null,
      untilMs: entry.untilMs,
      reason: typeof entry.reason === 'string' ? entry.reason : '',
      strikes: typeof entry.strikes === 'number' ? entry.strikes : 1,
    });
  }
  const models = typeof entry.models === 'object' && entry.models !== null ? entry.models : {};
  for (const [model, scope] of Object.entries(models)) {
    if (typeof scope !== 'object' || scope === null) continue;
    scopes.push({
      model,
      untilMs: typeof scope.untilMs === 'number' ? scope.untilMs : 0,
      reason: typeof scope.reason === 'string' ? scope.reason : '',
      strikes: typeof scope.strikes === 'number' ? scope.strikes : 1,
    });
  }
  return scopes;
}

/**
 * Build a readable cooldown reason from a failure.
 *
 * The upstream's Chinese message can arrive through several decode layers and
 * end up as mojibake, and no single re-decode fixes every case. Rather than
 * persist text that may be unreadable, this keeps a structured summary the UI
 * can always render — the machine-readable facts (code, status, reset instant)
 * plus whatever ASCII survives from the original message.
 *
 * @param failure - the failure object from `agent/request-error`.
 * @returns a short, always-displayable reason.
 */
function describeFailure(failure) {
  const parts = [];
  const code = typeof failure?.code === 'string' ? failure.code : '';
  if (code !== '') parts.push(code);
  const status = typeof failure?.status === 'number' ? failure.status : undefined;
  if (status !== undefined) parts.push(`http ${status}`);
  const resetAt = resetAtOf(failure);
  if (resetAt !== undefined) parts.push(`resets at ${new Date(resetAt).toISOString()}`);

  // Keep only the message's ASCII words: they are trustworthy regardless of how
  // the body was decoded, while CJK bytes may already be corrupt.
  const message = typeof failure?.message === 'string' ? failure.message : '';
  const ascii = message.replace(/[^\x20-\x7e]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (ascii !== '') parts.push(ascii.slice(0, 160));

  return parts.length > 0 ? parts.join(' · ') : 'quota exceeded';
}

/**
 * Record one quota failure and derive its cooldown.
 *
 * The cooldown is written against the scope the failure actually describes: a
 * credit exhaustion benches the whole account, while a per-model rate limit
 * benches just that model and leaves the login usable for every other model.
 * The upstream answers both with `429`, so this decision is what keeps a
 * throttled model from looking like a spent account.
 *
 * @param file - archive file that failed.
 * @param failure - the failure object from `agent/request-error`.
 * @param model - the model the failed request named, when known.
 * @returns the cooldown entry that was written, either shape.
 */
async function benchAccount(file, failure, model) {
  const accountWide = isAccountWideFailure(failure) || model === undefined || model === '';

  const now = Date.now();
  const upstreamReset = resetAtOf(failure);

  if (accountWide) {
    // A dead account supersedes any per-model scopes it carried: nothing about
    // this login works, so a narrower entry would only mask the real state.
    return updateState((state) => {
      const cooldowns =
        typeof state.cooldowns === 'object' && state.cooldowns !== null ? { ...state.cooldowns } : {};
      const previous = cooldowns[file] ?? {};
      const strikes = (typeof previous.strikes === 'number' ? previous.strikes : 0) + 1;
      const entry = {
        strikes,
        untilMs:
          upstreamReset !== undefined
            ? upstreamReset
            : now + (strikes >= HARD_BENCH_AFTER ? 24 * 3600 * 1000 : DEFAULT_COOLDOWN_MS),
        reason: describeFailure(failure).slice(0, 300),
        atMs: now,
      };
      cooldowns[file] = entry;
      state.cooldowns = cooldowns;
      return entry;
    });
  }

  return updateState((state) => {
    const cooldowns =
      typeof state.cooldowns === 'object' && state.cooldowns !== null ? { ...state.cooldowns } : {};
    const previous = cooldowns[file] ?? {};
    const models = typeof previous.models === 'object' && previous.models !== null ? { ...previous.models } : {};
    const priorScope = typeof models[model] === 'object' && models[model] !== null ? models[model] : {};
    const modelStrikes = (typeof priorScope.strikes === 'number' ? priorScope.strikes : 0) + 1;
    models[model] = {
      strikes: modelStrikes,
      untilMs:
        upstreamReset !== undefined
          ? upstreamReset
          : now + (modelStrikes >= HARD_BENCH_AFTER ? 24 * 3600 * 1000 : DEFAULT_COOLDOWN_MS),
      reason: describeFailure(failure).slice(0, 300),
      atMs: now,
    };
    const entry = {
      ...(typeof previous.untilMs === 'number' ? { untilMs: previous.untilMs, strikes: previous.strikes, reason: previous.reason, atMs: previous.atMs } : {}),
      models,
    };
    cooldowns[file] = entry;
    state.cooldowns = cooldowns;
    return entry;
  });
}

/**
 * Forget one account's cooldown.
 *
 * Without a model this clears every scope for the account — the manual "try
 * again, the quota is back" action. With a model it clears only that model's
 * scope, leaving any other model cooled on the same login untouched.
 *
 * @param file - archive file to clear.
 * @param model - a single model to unbench, or undefined to clear the account.
 */
async function clearBench(file, model) {
  await updateState((state) => {
    if (typeof state.cooldowns !== 'object' || state.cooldowns === null) return;
    if (!(file in state.cooldowns)) return;
    const cooldowns = { ...state.cooldowns };
    const entry = cooldowns[file];
    const models = typeof entry?.models === 'object' && entry.models !== null ? { ...entry.models } : {};
    const hasAccountScope = typeof entry?.untilMs === 'number';

    if (typeof model === 'string' && model !== '') {
      delete models[model];
      const remainingModels = Object.keys(models).length;
      if (hasAccountScope) {
        // The login is still exhausted: drop only the model's own scope and keep
        // the account-level cooldown, or clearing one model would silently reopen
        // an account the upstream said had no credits left.
        cooldowns[file] = remainingModels === 0
          ? {
              ...(typeof entry.strikes === 'number' ? { strikes: entry.strikes } : {}),
              untilMs: entry.untilMs,
              ...(typeof entry.reason === 'string' ? { reason: entry.reason } : {}),
              ...(typeof entry.atMs === 'number' ? { atMs: entry.atMs } : {}),
            }
          : { ...entry, models };
      } else if (remainingModels === 0) {
        delete cooldowns[file];
      } else {
        cooldowns[file] = { models };
      }
    } else {
      delete cooldowns[file];
    }
    state.cooldowns = cooldowns;
  });
}

/** The file currently selected, or undefined when the desktop app is in charge. */
async function selectedFile() {
  const state = await readState();
  const file = state.selected?.file;
  return typeof file === 'string' && file !== '' ? file : undefined;
}

/**
 * Pick the healthiest account to serve the next request.
 *
 * Order: not blocked for the failing model → latest refresh-token expiry →
 * newest archive. Preferring the account that lives longest keeps the pool from
 * rotating through accounts that are about to need a fresh sign-in.
 *
 * An account is only excluded when it cannot serve *this* model. A login that
 * is cooling on `claude-sonnet` is still a perfectly good candidate for
 * `gpt-5`, and treating it as dead is exactly the bug a model-scoped cooldown
 * exists to avoid.
 *
 * @param exclude - files that must not be considered (the one that just failed).
 * @param region - `cn` or `global`; only that region's archives are eligible.
 * @param model - the model the next request will use, when known.
 * @returns the chosen archive summary, or undefined when none is available.
 */
async function pickAccount(exclude, region, model) {
  const rows = (await listAccounts()).filter((row) => row.region === region && row.file !== exclude);
  if (rows.length === 0) return undefined;
  const cooldowns = await cooldownsNow();
  const healthy = rows.filter((row) => blockingScope(cooldowns[row.file], model) === undefined);
  if (healthy.length === 0) return undefined;
  healthy.sort((a, b) => b.refreshExpiresAtMs - a.refreshExpiresAtMs);
  return healthy[0];
}

/**
 * Move the provider to another account after a quota failure.
 *
 * The failing account is benched at the scope the failure describes, and the
 * replacement is only required to serve the same model — so a model-scoped
 * limit can still rotate to a sibling login, while the failed login stays in
 * rotation for every model it is not throttled on.
 *
 * @param failedFile - archive that produced the failure, or undefined when the
 *   desktop app's own credential was in use.
 * @param failure - the failure object from `agent/request-error`.
 * @param model - the model the failed request named, when known.
 * @returns the new selection, or undefined when no other account can serve it.
 */
async function rotateAwayFrom(failedFile, failure, model) {
  const region = 'cn';
  if (failedFile !== undefined) await benchAccount(failedFile, failure, model);
  const next = await pickAccount(failedFile, region, model);
  if (next === undefined) return undefined;
  await selectAccount(next.file);
  return { file: next.file, uid: next.uid, reason: 'quota', model };
}

/**
 * Hand the provider back to a recovered account once its cooldown has passed.
 *
 * A cooldown expiring only makes an account *eligible* again — nothing moves the
 * selection back, so after a rotation the pool would keep the runner-up forever
 * even though the original account has more quota. This sweep restores the
 * preference order: it picks the account with the longest refresh-token life
 * among all currently healthy archives and switches when that is not the one in
 * use.
 *
 * "Healthy" is evaluated for the model the session is actually routed to. A
 * model-scoped cooldown on the current login does not hold the sweep back when
 * the routed model is a different one.
 *
 * Three guards keep it from being disruptive:
 *
 * - a hand-picked account is left alone for {@link MANUAL_HOLD_MS}, so clicking
 *   "use this account" is not undone within the minute;
 * - it only acts when the currently selected account is itself healthy, so it
 *   never fights an in-progress rotation;
 * - it skips accounts that are mid-turn: `ctx.agents` is consulted for busy
 *   state, and a busy pool leaves the selection alone until the next sweep.
 *
 * @param ctx - host context carrying `ctx.agents`.
 * @returns the new file when it switched, otherwise undefined.
 */
async function reclaimRecovered(ctx) {
  const state = await readState();
  if (state.autoRotate === false) return undefined;
  const current = typeof state.selected?.file === 'string' ? state.selected.file : undefined;
  if (current === undefined) return undefined;

  // The user picked this account by hand and the hold has not run out: the
  // sweep has nothing to say. Quota rotation is unaffected — it runs on the
  // request-error path, not here.
  const holdUntilMs = state.selected?.holdUntilMs;
  if (typeof holdUntilMs === 'number' && holdUntilMs > Date.now()) return undefined;

  const model = routedModel(ctx, state.selected?.region === 'global' ? 'global' : 'cn');
  const cooldowns = await cooldownsNow();
  // Still cooling for the model in use: the rotation is doing its job.
  if (blockingScope(cooldowns[current], model) !== undefined) return undefined;

  const region = state.selected?.region === 'global' ? 'global' : 'cn';
  const rows = (await listAccounts()).filter((row) => row.region === region);
  if (rows.length < 2) return undefined;

  const healthy = rows.filter((row) => blockingScope(cooldowns[row.file], model) === undefined);
  if (healthy.length < 2) return undefined;
  healthy.sort((a, b) => b.refreshExpiresAtMs - a.refreshExpiresAtMs);
  const best = healthy[0];
  if (best.file === current) return undefined;

  // Do not move accounts under an active turn.
  if (poolIsBusy(ctx)) return undefined;

  await selectAccount(best.file);
  ctx.logger.info(
    `dsh-workbuddy-switcher: switched back to ${best.uid.slice(0, 8)} after its cooldown expired`,
  );
  return best.file;
}

/**
 * The model currently routed for this provider, when the host exposes it.
 *
 * The sweep needs a model to judge model-scoped cooldowns against. The running
 * sessions report theirs through `session.requestContext()`; when nothing is
 * running (the common case for a passive sweep) there is no routed model, and
 * the callers fall back to "any live scope blocks" — the safe reading.
 *
 * @param ctx - host context carrying `ctx.agents`.
 * @param region - `cn` or `global`; used to skip agents routed elsewhere.
 * @returns the routed model id, or undefined when unknown.
 */
function routedModel(ctx, region) {
  const provider = region === 'global' ? 'workbuddy-ai' : 'workbuddy';
  let agents;
  try {
    agents = ctx.get('agents');
  } catch {
    return undefined;
  }
  if (agents === undefined || agents === null) return undefined;
  try {
    const list = typeof agents.list === 'function' ? agents.list() : [];
    if (!Array.isArray(list)) return undefined;
    for (const agent of list) {
      if (typeof agent !== 'object' || agent === null) continue;
      const context = agent.session?.requestContext?.();
      if (context === undefined || context === null) continue;
      // Sessions on the other WorkBuddy variant say nothing about this pool.
      if (typeof context.provider === 'string' && context.provider !== provider) continue;
      if (typeof context.model === 'string' && context.model !== '') return context.model;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Whether any agent is currently working.
 *
 * The agents service is optional: an older host, or a moment before it loads,
 * leaves the sweep free to act.
 *
 * @param ctx - host context.
 * @returns true when at least one agent reports an active turn.
 */
function poolIsBusy(ctx) {
  let agents;
  try {
    agents = ctx.get('agents');
  } catch {
    return false;
  }
  if (agents === undefined || agents === null) return false;
  try {
    const list = typeof agents.list === 'function' ? agents.list() : [];
    return Array.isArray(list) && list.some((agent) => isAgentBusy(agent));
  } catch {
    return false;
  }
}

/**
 * Read one agent's busy flag without trusting its exact shape.
 *
 * @param agent - live agent handle.
 * @returns whether a turn or step is in progress.
 */
function isAgentBusy(agent) {
  if (typeof agent !== 'object' || agent === null) return false;
  for (const key of ['busy', 'running', 'isBusy', 'inFlight']) {
    if (agent[key] === true) return true;
  }
  const status = agent.status;
  if (typeof status === 'string') return status === 'working' || status === 'running';
  return false;
}

/**
 * Candidate install locations for the WorkBuddy desktop binary.
 *
 * The executable is needed as a *decryption oracle*: the at-rest key lives in
 * the app's own Electron binding, so the only way to read it is to run the app
 * as Node and call `electron_browser_workbuddy_storage`.
 *
 * There is no single install location to hardcode: the vendor's default is
 * `%LOCALAPPDATA%\Programs\WorkBuddy`, but per-machine installs land in
 * `Program Files`, and plenty of users pick a custom drive. Hardcoding one of
 * them made "import current account" fail with a bare `spawnSync … ENOENT` on
 * every other machine, so the path is discovered instead: an explicit override
 * wins, then the registry (which the installer always writes), then the usual
 * directories.
 *
 * @returns every path worth trying, most specific first.
 */
function electronBinCandidates() {
  const fromEnv = process.env['WORKBUDDY_ELECTRON_BIN'];
  const explicit = typeof fromEnv === 'string' ? fromEnv.trim() : '';
  const candidates = [];
  if (explicit !== '') candidates.push(explicit);

  // The installer records the real location even for a custom directory:
  // `DisplayIcon` is "<exe>,0" and `InstallLocation` is the directory.
  for (const key of [
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ]) {
    let listing;
    try {
      listing = execFileSync('reg', ['query', key, '/s', '/f', 'WorkBuddy'], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      });
    } catch {
      continue;
    }
    for (const match of listing.matchAll(/DisplayIcon\s+REG_(?:EXPAND_)?SZ\s+(.+?)(?:,\d+)?\s*$/gmu)) {
      candidates.push(match[1].trim());
    }
    for (const match of listing.matchAll(/InstallLocation\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/gmu)) {
      const location = match[1].trim();
      if (location !== '') candidates.push(join(location, 'WorkBuddy.exe'));
    }
  }

  const localAppData = process.env['LOCALAPPDATA'];
  if (typeof localAppData === 'string' && localAppData !== '') {
    candidates.push(join(localAppData, 'Programs', 'WorkBuddy', 'WorkBuddy.exe'));
  }
  for (const root of ['ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)']) {
    const dir = process.env[root];
    if (typeof dir === 'string' && dir !== '') {
      candidates.push(join(dir, 'WorkBuddy', 'WorkBuddy.exe'));
    }
  }

  return [...new Set(candidates)];
}

/**
 * Locate the WorkBuddy desktop binary, or explain how to point at it.
 *
 * The error is written for the person who hits it: they can install nothing
 * more, so it names the setting that fixes the problem.
 *
 * @returns an existing executable path.
 */
function electronBin() {
  const candidates = electronBinCandidates();
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found !== undefined) return found;
  throw new Error(
    '没找到 WorkBuddy 可执行文件，无法解密凭据。' +
      '请把环境变量 WORKBUDDY_ELECTRON_BIN 设成 WorkBuddy.exe 的完整路径后重启 DSH' +
      `（已查找：${candidates.join('、') || '无候选路径'}）`,
  );
}

/**
 * Display name an account was saved under outside the credential itself.
 *
 * The archive only carries what the token document carries, and a WorkBuddy
 * login arrives with its nickname encrypted in a field the token parser drops.
 * `importCurrent` now decrypts that field, and this map keeps a name the user
 * typed by hand for archives that predate it. State file, not the archive: a
 * token refresh rewrites the archive from the canonical credential and would
 * drop anything stored there.
 *
 * @param state - parsed state document.
 * @param file - archive filename.
 * @returns the saved label, or undefined.
 */
function savedLabel(state, file) {
  const labels = state.labels;
  if (typeof labels !== 'object' || labels === null) return undefined;
  const value = labels[file];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Archive whatever credential the desktop app currently exposes. */
async function importCurrent() {
  const { createHash, createDecipheriv } = await import('node:crypto');
  const electron = electronBin();
  const helper =
    'process.stdout.write(String(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))';

  const candidates = [
    join(homedir(), 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
    join(homedir(), 'AppData', 'Roaming', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
  ];
  const desktop = candidates.find((candidate) => existsSync(candidate));
  if (desktop === undefined) throw new Error('no WorkBuddy desktop auth file found');

  const document = JSON.parse(await readFile(desktop, 'utf8'));
  const auth = typeof document.auth === 'object' && document.auth !== null ? document.auth : document;
  const identity =
    typeof document.account === 'object' && document.account !== null ? document.account : document;

  const wrapped = [];
  for (const field of ['accessToken', 'refreshToken', 'nickname']) {
    const value = auth[field] ?? (field === 'nickname' ? identity.nickname : undefined);
    if (typeof value === 'object' && value !== null && value.$wbEncrypted === 1) {
      const parts = JSON.parse(Buffer.from(String(value.envelope), 'base64').toString('utf8'));
      wrapped.push({
        field,
        suite: parts.suite,
        keyId: parts.keyId,
        nonce: Buffer.from(parts.nonce, 'base64'),
        authTag: Buffer.from(parts.authTag, 'base64'),
        ciphertext: Buffer.from(parts.ciphertext, 'base64'),
      });
    }
  }

  const plain = { ...auth };
  // The nickname lives on the identity, not inside `auth`; decrypt it into the
  // copy that becomes the archive's `account` object.
  const account = { ...identity };
  if (wrapped.length > 0) {
    const stdout = execFileSync(electron, ['-e', helper], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 30000,
      maxBuffer: 1 << 20,
      windowsHide: true,
    }).toString();
    const payload = JSON.parse(stdout.trim());
    const key = createHash('sha256').update(payload.atRestSecretKey, 'utf8').digest();
    const keyId = createHash('sha256').update(key).digest('hex').slice(0, 16);
    for (const field of wrapped) {
      if (field.keyId !== keyId) throw new Error('at-rest key id mismatch');
      const suiteBytes = Buffer.allocUnsafe(4);
      suiteBytes.writeUInt32BE(field.suite);
      const lenPrefix = (value) => {
        const bytes = Buffer.from(value, 'utf8');
        const header = Buffer.allocUnsafe(4);
        header.writeUInt32BE(bytes.length);
        return Buffer.concat([header, bytes]);
      };
      const aad = Buffer.concat([
        Buffer.from('WB-AAD\0', 'ascii'),
        Buffer.from([1]),
        lenPrefix('WBEV1'),
        lenPrefix('sym-v1'),
        suiteBytes,
        lenPrefix(field.keyId),
        Buffer.from([2]),
        Buffer.from([0]),
        Buffer.from([0]),
      ]);
      const decipher = createDecipheriv('aes-256-gcm', key, field.nonce, { authTagLength: 16 });
      decipher.setAAD(aad);
      decipher.setAuthTag(field.authTag);
      const text = Buffer.concat([
        decipher.update(field.ciphertext),
        decipher.final(),
      ]).toString('utf8');
      if (field.field === 'nickname') account.nickname = text;
      else plain[field.field] = text;
    }
  }

  const credential = canonicalFromDocument({ ...plain, auth: plain, account });
  if (credential === undefined) throw new Error('decrypted credential carries no accessToken');

  const dir = accountsDir();
  mkdirSync(dir, { recursive: true });
  const file = `${credential.uid === '' ? `unknown-${Date.now()}` : credential.uid}.json`;
  await writeFile(join(dir, file), `${JSON.stringify(toDesktopDocument(credential), null, 2)}\n`, {
    mode: 384,
  });
  return { file, uid: credential.uid };
}

async function deleteAccount(file) {
  const dir = accountsDir();
  const path = join(dir, file);
  if (!existsSync(path)) throw new Error(`unknown account archive: ${file}`);
  const state = await readState();
  if (state.selected?.file === file) await selectAccount(null);
  await rm(path, { force: true });
  return { deleted: file };
}

/**
 * Read the account the WorkBuddy desktop app is currently signed in to.
 *
 * Only identity fields are read here — never the tokens — so this can run on
 * every status poll without paying the at-rest decryption cost. The panel uses
 * it to point out a freshly signed-in account that has no archive yet.
 *
 * @returns the app's account identity, or undefined when it is signed out.
 */
async function readClientAccount() {
  const candidates = [
    join(homedir(), 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
    join(homedir(), 'AppData', 'Roaming', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (path === undefined) return undefined;
  const document = await readJson(path);
  if (document === undefined || typeof document !== 'object' || document === null) return undefined;
  const identity =
    typeof document.account === 'object' && document.account !== null ? document.account : undefined;
  if (identity === undefined) return undefined;
  const uid = typeof identity.uid === 'string' ? identity.uid : '';
  if (uid === '') return undefined;
  return {
    uid,
    nickname: typeof identity.nickname === 'string' ? identity.nickname : '',
    type: typeof identity.type === 'string' ? identity.type : '',
  };
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Only a loopback Host may reach this route (anti DNS-rebinding). */
function loopbackRequest(req) {
  const host = req.headers.host;
  if (typeof host !== 'string') return false;
  const hostname = host.replace(/:\d+$/u, '');
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      // Large enough for a bundle of many accounts (each archive is ~2.3 KB);
      // the route is loopback-only, so this bounds a local mistake rather than
      // a remote attack.
      if (size > 8_000_000) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const ROUTE = '/plugins/dsh-workbuddy-switcher/accounts';

/**
 * Format marker for a credential bundle.
 *
 * Bumped only when the *envelope* changes shape. The individual credentials
 * inside keep using the desktop shape, so a bundle can be inspected by hand and
 * an archive can be dropped straight into the accounts directory.
 */
const BUNDLE_FORMAT = 'dsh-workbuddy-accounts/v1';

/**
 * Export every archive as one portable bundle.
 *
 * The bundle carries the credentials verbatim — this is a plaintext hand-off by
 * design, so it is only ever produced on an explicit user action, and the UI
 * states that plainly. No bookkeeping (cooldowns, selection) travels with it:
 * that state is machine-local and would be wrong on the other machine.
 *
 * @returns the bundle document.
 */
async function exportBundle() {
  const dir = accountsDir();
  const accounts = [];
  const skipped = [];
  let names = [];
  try {
    names = await readdir(dir);
  } catch {
    names = [];
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const document = await readJson(join(dir, name));
    const credential = canonicalFromDocument(document);
    // Copies of one account collapse to the canonical file, same rule the panel
    // uses — an export should not ship three variants of the same login.
    if (credential === undefined) {
      skipped.push({ file: name, reason: 'unreadable' });
      continue;
    }
    accounts.push({ file: name, document: toDesktopDocument(credential) });
  }

  const rows = accounts
    .map((entry) => ({ entry, credential: canonicalFromDocument(entry.document) }))
    .filter((row) => row.credential !== undefined);
  const canonical = (row) =>
    row.credential.uid !== '' && row.entry.file.replace(/\.json$/, '') === row.credential.uid;
  const best = new Map();
  for (const row of rows) {
    const key = `${row.credential.uid}:${row.credential.enterpriseId ?? ''}`;
    const previous = best.get(key);
    if (
      previous === undefined ||
      (canonical(row) !== canonical(previous)
        ? canonical(row)
        : (row.credential.refreshExpiresAtMs ?? 0) > (previous.credential.refreshExpiresAtMs ?? 0))
    ) {
      best.set(key, row);
    }
  }

  return {
    format: BUNDLE_FORMAT,
    exportedAt: new Date().toISOString(),
    // Explicit so whoever opens the file knows what they are holding.
    warning: 'PLAINTEXT CREDENTIALS — contains live WorkBuddy access tokens. Store securely.',
    accounts: [...best.values()]
      .sort((a, b) => (b.credential.refreshExpiresAtMs ?? 0) - (a.credential.refreshExpiresAtMs ?? 0))
      .map((row) => ({
        file: row.entry.file,
        uid: row.credential.uid,
        nickname: row.credential.nickname ?? '',
        domain: row.credential.domain,
        region: isGlobalDomain(row.credential.domain) ? 'global' : 'cn',
        expiresAtMs: row.credential.expiresAtMs,
        refreshExpiresAtMs: row.credential.refreshExpiresAtMs ?? 0,
        document: row.entry.document,
      })),
    skipped,
  };
}

/**
 * Merge a bundle into the accounts directory.
 *
 * Import is additive and never destructive: an account already present is kept
 * unless the incoming copy has a later refresh expiry, and files that already
 * exist are backed up before being replaced. That way importing an older export
 * on the machine that produced it cannot log you out.
 *
 * @param bundle - parsed bundle document.
 * @returns what was added, refreshed, kept and skipped.
 */
async function importBundle(bundle) {
  if (typeof bundle !== 'object' || bundle === null) throw new Error('bundle is not an object');
  if (bundle.format !== BUNDLE_FORMAT) {
    throw new Error(`unsupported bundle format: ${String(bundle.format)} (expected ${BUNDLE_FORMAT})`);
  }
  const incoming = Array.isArray(bundle.accounts) ? bundle.accounts : [];
  if (incoming.length === 0) throw new Error('bundle contains no accounts');

  const dir = accountsDir();
  mkdirSync(dir, { recursive: true });

  const existing = new Map();
  for (const row of await listAccounts()) {
    existing.set(`${row.uid}:${row.enterpriseId}`, row);
  }

  const added = [];
  const refreshed = [];
  const kept = [];

  for (const entry of incoming) {
    const credential = canonicalFromDocument(entry?.document);
    if (credential === undefined) continue;
    const key = `${credential.uid}:${credential.enterpriseId ?? ''}`;
    const file = `${credential.uid === '' ? `imported-${Date.now()}` : credential.uid}.json`;
    const path = join(dir, file);
    const current = existing.get(key);

    if (current !== undefined) {
      const currentRefresh = current.refreshExpiresAtMs ?? 0;
      const incomingRefresh = credential.refreshExpiresAtMs ?? 0;
      // Same account, and the local token lives at least as long: keep it.
      if (currentRefresh >= incomingRefresh) {
        kept.push({ uid: credential.uid, file: current.file });
        continue;
      }
      // Replace, but keep a copy of what was there first.
      if (existsSync(path)) {
        await rename(path, `${path}.imported-${Date.now()}`);
      }
      await writeFile(path, `${JSON.stringify(toDesktopDocument(credential), null, 2)}\n`, {
        mode: 384,
      });
      refreshed.push({ uid: credential.uid, file });
      continue;
    }

    if (existsSync(path)) {
      await rename(path, `${path}.imported-${Date.now()}`);
    }
    await writeFile(path, `${JSON.stringify(toDesktopDocument(credential), null, 2)}\n`, {
      mode: 384,
    });
    added.push({ uid: credential.uid, file });
    existing.set(key, { file, uid: credential.uid, refreshExpiresAtMs: credential.refreshExpiresAtMs ?? 0 });
  }

  return { added, refreshed, kept, total: added.length + refreshed.length + kept.length };
}

/**
 * Make `dsh-workbuddy-connect` adopt the newly selected credential immediately
 * instead of waiting for its 30-second credential sweep.
 *
 * That plugin exposes two loopback routes: the read-only status route hands out
 * a per-process `probeKey`, and the control route accepts `{action:"refresh"}`
 * with that key. A refresh re-reads the credential, re-adopts the identity and
 * re-fetches the model catalog, then invalidates its adapter — which is what
 * makes the model selector show the new account's models without a reload.
 *
 * Both variants are nudged; a signed-out one simply answers `signed-out`.
 *
 * @param ctx - the host context, whose `webServer` supplies the origin.
 * @returns one outcome per variant, for the UI to report.
 */
async function nudgeWorkBuddy(ctx) {
  let origin;
  try {
    origin = ctx.webServer.getOrigin();
  } catch {
    return { skipped: 'web-server-not-listening' };
  }
  const variants = [
    { id: 'cn', path: '' },
    { id: 'ai', path: '/ai' },
  ];
  const outcomes = [];
  for (const variant of variants) {
    const statusUrl = `${origin}/plugins/dsh-workbuddy-connect${variant.path}/status`;
    const probeUrl = `${origin}/plugins/dsh-workbuddy-connect${variant.path}/probe`;
    try {
      const status = await fetch(statusUrl, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      if (!status.ok) {
        outcomes.push({ variant: variant.id, state: `status-http-${status.status}` });
        continue;
      }
      const document = await status.json();
      const key = document?.probeKey;
      if (typeof key !== 'string' || key === '') {
        outcomes.push({ variant: variant.id, state: 'no-probe-key' });
        continue;
      }
      const probe = await fetch(probeUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-workbuddy-probe-key': key },
        body: JSON.stringify({ action: 'refresh' }),
        signal: AbortSignal.timeout(60000),
      });
      const body = await probe.json().catch(() => undefined);
      outcomes.push({
        variant: variant.id,
        state: probe.ok ? (body?.state ?? 'ok') : `probe-http-${probe.status}`,
        ...(typeof body?.reason === 'string' ? { reason: body.reason } : {}),
      });
    } catch (error) {
      outcomes.push({
        variant: variant.id,
        state: 'error',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { outcomes };
}

/**
 * Build the route handler bound to one host context.
 *
 * @param ctx - host context whose `webServer` supplies the loopback origin.
 * @returns the request handler for {@link ROUTE}.
 */
function createHandler(ctx) {
  return async (req, res) => {
  if (!loopbackRequest(req)) {
    json(res, 403, { error: 'request-not-trusted' });
    return;
  }
  try {
    if (req.method === 'GET') {
      const state = await readState();
      const cooldowns = await cooldownsNow();
      const accounts = await listAccounts();
      const model = routedModel(ctx, state.selected?.region === 'global' ? 'global' : 'cn');
      const day = shanghaiDay();
      const checkinAccounts = state.checkin?.accounts ?? {};
      json(res, 200, {
        dir: accountsDir(),
        // The model the pool is currently judged against, so the panel can say
        // which screens are model-scoped instead of leaving the user guessing
        // why a login with a 429 still shows as usable.
        activeModel: model ?? null,
        accounts: accounts.map((account) => {
          const entry = cooldowns[account.file];
          const scopes = cooldownScopes(entry);
          const blocking = blockingScope(entry, model);
          return {
            ...account,
            // A hand-typed name wins over the encrypted one the archive
            // carries: the user knows which login is which, the token does not.
            label: savedLabel(state, account.file) ?? null,
            // Per-scope detail: one record per live cooldown, `model: null`
            // meaning the whole account. The flat fields below describe the
            // scope that would block the next request, so an older client still
            // renders something sensible.
            cooldowns: scopes,
            // True when the next request on this login would actually be
            // rejected, as opposed to merely carrying an unrelated model's
            // limit. The panel uses it to pick the badge weight.
            blocked: blocking !== undefined,
            ...(blocking === undefined
              ? {}
              : {
                  cooldownUntilMs: blocking.untilMs,
                  cooldownReason: blocking.reason,
                  cooldownModel: blocking.model ?? null,
                }),
            ...(scopes.length === 0
              ? {}
              : {
                  // Any cooldown at all, even one that is not blocking the
                  // current model — an older client renders this one.
                  coolingUntilMs: Math.max(...scopes.map((scope) => scope.untilMs)),
                }),
          };
        }),
        selected: activeSelection(),
        selectedFile: state.selected?.file ?? null,
        // When the hand-picked account becomes reclaimable again. The panel
        // shows it so "why didn't it switch back?" has an answer on screen.
        holdUntilMs:
          typeof state.selected?.holdUntilMs === 'number' && state.selected.holdUntilMs > Date.now()
            ? state.selected.holdUntilMs
            : null,
        clientAccount: await readClientAccount(),
        autoRotate: state.autoRotate !== false,
        // Daily check-in: the switch, when the last sweep ran, and one record
        // per archive. The panel renders the badge from `accounts[file]`, so a
        // machine where nothing has run yet simply shows no badge.
        checkin: {
          enabled: state.checkin?.enabled !== false,
          today: day,
          lastSweepAt:
            typeof state.checkin?.lastSweepAt === 'number' ? state.checkin.lastSweepAt : null,
          accounts: Object.fromEntries(
            accounts.map((account) => {
              const entry = checkinAccounts[account.file];
              if (typeof entry !== 'object' || entry === null) return [account.file, null];
              // A record from an earlier day is history, not state: the panel
              // must not claim "today +100" because yesterday's sweep said so.
              const fresh = entry.day === day;
              return [
                account.file,
                {
                  result: typeof entry.result === 'string' ? entry.result : 'unknown',
                  today: fresh,
                  day: typeof entry.day === 'string' ? entry.day : null,
                  credit: typeof entry.credit === 'number' ? entry.credit : null,
                  streakDays: typeof entry.streakDays === 'number' ? entry.streakDays : null,
                  totalCredits: typeof entry.totalCredits === 'number' ? entry.totalCredits : null,
                  endTime: typeof entry.endTime === 'string' ? entry.endTime : null,
                  attempts: typeof entry.attempts === 'number' ? entry.attempts : 0,
                  nextAttemptMs:
                    typeof entry.nextAttemptMs === 'number' ? entry.nextAttemptMs : null,
                  reason: typeof entry.reason === 'string' ? entry.reason : '',
                },
              ];
            }),
          ),
        },
      });
      return;
    }
    if (req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const action = body.action;
      if (action === 'select') {
        const result = await selectAccount(
          typeof body.file === 'string' ? body.file : null,
          'user',
        );
        json(res, 200, { ...result, refresh: await nudgeWorkBuddy(ctx) });
        return;
      }
      if (action === 'clear') {
        const result = await selectAccount(null);
        json(res, 200, { ...result, refresh: await nudgeWorkBuddy(ctx) });
        return;
      }
      if (action === 'refresh') {
        json(res, 200, { refresh: await nudgeWorkBuddy(ctx) });
        return;
      }
      if (action === 'import') {
        json(res, 200, await importCurrent());
        return;
      }
      if (action === 'rename') {
        const file = typeof body.file === 'string' ? body.file : '';
        if (!existsSync(join(accountsDir(), file))) throw new Error(`unknown account archive: ${file}`);
        const label = typeof body.label === 'string' ? body.label.trim().slice(0, 40) : '';
        await updateState((state) => {
          const labels = typeof state.labels === 'object' && state.labels !== null ? state.labels : {};
          if (label === '') delete labels[file];
          else labels[file] = label;
          state.labels = labels;
        });
        json(res, 200, { file, label: label === '' ? null : label });
        return;
      }
      if (action === 'delete') {
        json(res, 200, await deleteAccount(body.file));
        return;
      }
      if (action === 'export') {
        json(res, 200, await exportBundle());
        return;
      }
      if (action === 'import-bundle') {
        json(res, 200, await importBundle(body.bundle));
        return;
      }
      if (action === 'set-auto-rotate') {
        const enabled = body.enabled === true;
        await updateState((state) => {
          state.autoRotate = enabled;
        });
        json(res, 200, { autoRotate: enabled });
        return;
      }
      if (action === 'clear-cooldown') {
        if (typeof body.file === 'string') {
          await clearBench(body.file, typeof body.model === 'string' ? body.model : undefined);
        }
        json(res, 200, { cleared: body.file ?? null, model: body.model ?? null });
        return;
      }
      if (action === 'checkin') {
        // A manual run ignores both the daily short-circuit and the switch: the
        // user asked for this click, and the claim is idempotent anyway. Clicks
        // that arrive while a sweep is running join it instead of starting
        // another one — see {@link sweepOnce}.
        const file = typeof body.file === 'string' ? body.file : undefined;
        const swept = await sweepOnce(ctx, {
          ...(file === undefined ? {} : { files: [file] }),
          manual: true,
        });
        json(res, 200, swept);
        return;
      }
      if (action === 'set-checkin') {
        const enabled = body.enabled === true;
        await updateState((state) => {
          state.checkin = { ...(state.checkin ?? {}), enabled };
        });
        json(res, 200, { checkin: { enabled } });
        return;
      }
      json(res, 400, { error: `unknown action: ${String(action)}` });
      return;
    }
    json(res, 405, { error: 'method not allowed' });
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
  };
}

export const name = 'workbuddy-switcher';
export const inject = ['webServer'];

/**
 * Register the quota-rotation listener on the agent's failed-request hook.
 *
 * Ordering against `dsh-llm-retry` is the whole trick:
 *
 * - `waterfall` runs listeners outermost-first, and the first registered
 *   listener is outermost — so `prepend: true` is what puts this handler ahead
 *   of llm-retry instead of behind it;
 * - a listener that does not call `next()` vetoes everything after it, so
 *   llm-retry never sees the quota failure and cannot spend its retry budget
 *   re-hitting the same exhausted account;
 * - the handler must hand back `{kind:'retry'}` itself, which is the same
 *   contract llm-retry produces, so the agent loop re-runs the step.
 *
 * Any other failure falls through to `next()` untouched, leaving llm-retry's
 * normal backoff in charge.
 *
 * @param ctx - host context carrying the event emitter.
 */
function installRotation(ctx) {
  let inFlight = false;
  const dispose = ctx.on(
    'agent/request-error',
    async (payload, next) => {
      // Only quota failures are worth moving accounts for.
      if (!isQuotaFailure(payload?.failure)) return next();
      if (inFlight) return next();

      // The desktop app's own credential is not one of our archives, so there is
      // nothing to bench and no sibling to rotate to.
      const failed = await selectedFile();
      if (failed === undefined) return next();
      const state = await readState();
      if (state.autoRotate === false) return next();

      inFlight = true;
      try {
        // The model is what decides the scope: a 429 that named one model must
        // bench that model only, while 402 / credit wording benches the login.
        const model = modelOfFailedRequest(payload);
        const moved = await rotateAwayFrom(failed, payload.failure, model);
        if (moved === undefined) {
          ctx.logger.warn(
            'dsh-workbuddy-switcher: quota failure with no other healthy account; leaving the error to surface',
          );
          return next();
        }
        ctx.logger.info(
          moved.model === undefined
            ? `dsh-workbuddy-switcher: rotated to ${moved.uid.slice(0, 8)} after a quota failure`
            : `dsh-workbuddy-switcher: rotated to ${moved.uid.slice(0, 8)} after ${moved.model} was rate limited`,
        );
        return { kind: 'retry' };
      } catch (error) {
        ctx.logger.warn('dsh-workbuddy-switcher: rotation failed', error);
        return next();
      } finally {
        inFlight = false;
      }
    },
    { prepend: true },
  );
  ctx.effect(() => dispose, 'dsh-workbuddy-switcher: quota rotation');
}

/**
 * The model the failed request named.
 *
 * `agent/request-error` carries `provider` but not `model`, so the model comes
 * from the failing agent's routings, with a parser over the failure message as
 * the fallback for hosts that do not expose a session. Getting this right is
 * what keeps a per-model `429` from benching a whole login — without a model the
 * cooldown cannot be narrowed, and {@link benchAccount} falls back to the
 * account scope.
 *
 * @param payload - the `agent/request-error` payload.
 * @returns the model id, or undefined when it cannot be determined.
 */
function modelOfFailedRequest(payload) {
  const session = payload?.agent?.session;
  try {
    const context = session?.requestContext?.();
    if (typeof context?.model === 'string' && context.model !== '') return context.model;
  } catch {
    // A host without the accessor falls through to the message scan below.
  }
  try {
    const header = session?.requestHeader?.();
    const model = header?.config?.model;
    if (typeof model === 'string' && model !== '') return model;
  } catch {
    // Same: the message scan is the last resort.
  }
  // The shim reports `workbuddy upstream soft_rate ...` and the upstream body
  // names the model when it is the model that was limited.
  const message = typeof payload?.failure?.message === 'string' ? payload.failure.message : '';
  const match = /"(?:model|modelId)"\s*:\s*"([^"]+)"/.exec(message);
  return match?.[1];
}

/**
 * How often the reclaim sweep looks for a recovered account.
 *
 * The sweep is cheap (a few small file reads) and does nothing unless a switch
 * would actually gain something, so it can run often enough that the user never
 * notices waiting for a quota window to open.
 */
const RECLAIM_INTERVAL_MS = 60 * 1000;

/**
 * Keep running {@link reclaimRecovered} for the life of the plugin.
 *
 * The first pass is delayed by one interval so startup stays quiet and the
 * restore-from-state-file path wins.
 *
 * @param ctx - host context.
 */
function installReclaimSweep(ctx) {
  const timer = setInterval(() => {
    void reclaimRecovered(ctx).catch((error) => {
      ctx.logger.warn('dsh-workbuddy-switcher: reclaim sweep failed', error);
    });
  }, RECLAIM_INTERVAL_MS);
  timer.unref?.();
  ctx.effect(() => () => clearInterval(timer), 'dsh-workbuddy-switcher: reclaim sweep');
}

/**
 * Keep the daily check-in running for the life of the plugin.
 *
 * Two timers, on purpose:
 *
 * - a first pass shortly after startup, delayed so it never competes with the
 *   archive migration or the credential swap that happens at boot. This is the
 *   one that catches up after the machine was off overnight — the whole point of
 *   running it here rather than relying on a fixed midnight alarm;
 * - a low-frequency sweep afterwards. Once every account is settled for the day
 *   each pass costs a handful of file reads and sends nothing, so a 30-minute
 *   cadence is cheap insurance against a failed first attempt.
 *
 * The interval callback never rejects into the event loop: a check-in problem
 * must not surface as an unhandled rejection in the host.
 *
 * @param ctx - host context, for logging.
 */
function installCheckinSweep(ctx) {
  // Shares the process-wide in-flight guard with the panel's buttons, so the
  // timer and a click can never run two sweeps at once.
  const pass = (label) => {
    void sweepOnce(ctx).catch((error) => {
      ctx.logger?.warn?.(`dsh-workbuddy-switcher: check-in sweep failed (${label})`, error);
    });
  };

  const startup = setTimeout(() => pass('startup'), CHECKIN_STARTUP_DELAY_MS);
  startup.unref?.();
  const timer = setInterval(() => pass('interval'), CHECKIN_INTERVAL_MS);
  timer.unref?.();

  ctx.effect(
    () => () => {
      clearTimeout(startup);
      clearInterval(timer);
    },
    'dsh-workbuddy-switcher: daily check-in',
  );
}

export function apply(ctx) {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: ROUTE,
      handler: createHandler(ctx),
    });
    return () => dispose();
  }, 'dsh-workbuddy-switcher: accounts route');

  ctx.effect(() => {
    void migrateArchives().then((migrated) => {
      if (migrated.length > 0) {
        ctx.logger.info(
          `dsh-workbuddy-switcher: converted ${migrated.length} archive(s) to the desktop credential shape`,
        );
      }
    });
  }, 'dsh-workbuddy-switcher: archive migration');

  installReclaimSweep(ctx);

  // The daily check-in needs nothing but the archive directory, so it starts
  // unconditionally — unlike rotation, which waits for the agent service.
  installCheckinSweep(ctx);

  // The rotation needs the agent's failure hook, which only exists once the
  // agent service is present.
  ctx.inject(['agents'], () => installRotation(ctx));
}
