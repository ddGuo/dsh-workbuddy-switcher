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
 * - a cooled account is skipped until its reset time, and every account is
 *   cooled by some amount so a permanently dead one cannot be retried in a loop;
 * - the rotation is disabled with one switch, and the previous selection is
 *   restored from the state file on the next start.
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { canonicalFromDocument, isGlobalDomain, toDesktopDocument } from './format.js';

const CN_ENV = 'WORKBUDDY_AUTH_FILE';
const AI_ENV = 'WORKBUDDY_AI_AUTH_FILE';
const DEFAULT_DIR = join(homedir(), '.dsh', 'workbuddy-accounts');
const STATE_FILE = join(homedir(), '.dsh', 'workbuddy-switcher.json');

/** Consecutive quota failures before an account is benched for the rest of the day. */
const HARD_BENCH_AFTER = 3;
/** Fallback cooldown when the upstream gives no reset time (ms). */
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;

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
  if (code === 'RATE_LIMIT' || code === 'QUOTA_EXCEEDED' || code === 'soft_rate' || code === 'hard_credit') {
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
  const match = /将在\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(message);
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

async function readState() {
  const state = await readJson(STATE_FILE);
  return typeof state === 'object' && state !== null ? state : {};
}

async function writeState(next) {
  await mkdir(join(homedir(), '.dsh'), { recursive: true });
  const temporary = `${STATE_FILE}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 384 });
  await rename(temporary, STATE_FILE);
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
 */
async function selectAccount(file) {
  const dir = accountsDir();
  const next = await readState();
  if (file === null || file === undefined) {
    delete process.env[CN_ENV];
    delete process.env[AI_ENV];
    delete next.selected;
    await writeState(next);
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
  next.selected = {
    file,
    uid: row.uid,
    domain: row.domain,
    region: row.region,
    selectedAt: Date.now(),
  };
  await writeState(next);
  return { selected: activeSelection() };
}

/**
 * Cooldown bookkeeping, keyed by archive file.
 *
 * Persisted next to the selection so a DSH restart neither forgets that an
 * account is out of quota nor retries it immediately. Entries expire on their
 * own: a cooled account re-enters the rotation as soon as its window passes.
 *
 * @returns the live cooldown map, pruned of expired entries.
 */
async function cooldownsNow() {
  const state = await readState();
  const raw = typeof state.cooldowns === 'object' && state.cooldowns !== null ? state.cooldowns : {};
  const now = Date.now();
  const live = {};
  for (const [file, entry] of Object.entries(raw)) {
    if (typeof entry !== 'object' || entry === null) continue;
    if (typeof entry.untilMs === 'number' && entry.untilMs > now) live[file] = entry;
  }
  return live;
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
 * Record one quota failure for an account and derive its cooldown.
 *
 * @param file - archive file that failed.
 * @param failure - the failure object from `agent/request-error`.
 * @returns the cooldown entry that was written.
 */
async function benchAccount(file, failure) {
  const state = await readState();
  const cooldowns = typeof state.cooldowns === 'object' && state.cooldowns !== null ? { ...state.cooldowns } : {};
  const previous = cooldowns[file] ?? {};
  const strikes = (typeof previous.strikes === 'number' ? previous.strikes : 0) + 1;
  const upstreamReset = resetAtOf(failure);
  const untilMs =
    upstreamReset !== undefined
      ? upstreamReset
      : Date.now() + (strikes >= HARD_BENCH_AFTER ? 24 * 3600 * 1000 : DEFAULT_COOLDOWN_MS);
  const entry = {
    strikes,
    untilMs,
    reason: describeFailure(failure).slice(0, 300),
    atMs: Date.now(),
  };
  cooldowns[file] = entry;
  state.cooldowns = cooldowns;
  await writeState(state);
  return entry;
}

/** Forget one account's cooldown (manual "try again" / successful request). */
async function clearBench(file) {
  const state = await readState();
  if (typeof state.cooldowns !== 'object' || state.cooldowns === null) return;
  if (!(file in state.cooldowns)) return;
  const cooldowns = { ...state.cooldowns };
  delete cooldowns[file];
  state.cooldowns = cooldowns;
  await writeState(state);
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
 * Order: not cooled → latest refresh-token expiry → newest archive. Preferring
 * the account that lives longest keeps the pool from rotating through accounts
 * that are about to need a fresh sign-in.
 *
 * @param exclude - files that must not be considered (the one that just failed).
 * @param region - `cn` or `global`; only that region's archives are eligible.
 * @returns the chosen archive summary, or undefined when none is available.
 */
async function pickAccount(exclude, region) {
  const rows = (await listAccounts()).filter((row) => row.region === region && row.file !== exclude);
  if (rows.length === 0) return undefined;
  const cooldowns = await cooldownsNow();
  const healthy = rows.filter((row) => cooldowns[row.file] === undefined);
  const pool = healthy.length > 0 ? healthy : [];
  if (pool.length === 0) return undefined;
  pool.sort((a, b) => b.refreshExpiresAtMs - a.refreshExpiresAtMs);
  return pool[0];
}

/**
 * Move the provider to another account after a quota failure.
 *
 * @param failedFile - archive that produced the failure, or undefined when the
 *   desktop app's own credential was in use.
 * @param failure - the failure object from `agent/request-error`.
 * @returns the new selection, or undefined when no other account can serve it.
 */
async function rotateAwayFrom(failedFile, failure) {
  const region = 'cn';
  if (failedFile !== undefined) await benchAccount(failedFile, failure);
  const next = await pickAccount(failedFile, region);
  if (next === undefined) return undefined;
  await selectAccount(next.file);
  return { file: next.file, uid: next.uid, reason: 'quota' };
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
 * Two guards keep it from being disruptive:
 *
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

  const cooldowns = await cooldownsNow();
  // Still cooling: the rotation is doing its job, leave it alone.
  if (cooldowns[current] !== undefined) return undefined;

  const region = state.selected?.region === 'global' ? 'global' : 'cn';
  const rows = (await listAccounts()).filter((row) => row.region === region);
  if (rows.length < 2) return undefined;

  const healthy = rows.filter((row) => cooldowns[row.file] === undefined);
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

/** Archive whatever credential the desktop app currently exposes. */
async function importCurrent() {
  const { execFileSync } = await import('node:child_process');
  const { createHash, createDecipheriv } = await import('node:crypto');
  const electron = process.env['WORKBUDDY_ELECTRON_BIN'] ?? 'D:\\WorkBuddy\\WorkBuddy.exe';
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
  for (const field of ['accessToken', 'refreshToken']) {
    const value = auth[field];
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
      plain[field.field] = Buffer.concat([
        decipher.update(field.ciphertext),
        decipher.final(),
      ]).toString('utf8');
    }
  }

  const credential = canonicalFromDocument({ ...plain, auth: plain, account: identity });
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
      json(res, 200, {
        dir: accountsDir(),
        accounts: accounts.map((account) => ({
          ...account,
          ...(cooldowns[account.file] === undefined
            ? {}
            : {
                cooldownUntilMs: cooldowns[account.file].untilMs,
                cooldownReason: cooldowns[account.file].reason,
              }),
        })),
        selected: activeSelection(),
        selectedFile: state.selected?.file ?? null,
        clientAccount: await readClientAccount(),
        autoRotate: state.autoRotate !== false,
      });
      return;
    }
    if (req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const action = body.action;
      if (action === 'select') {
        const result = await selectAccount(typeof body.file === 'string' ? body.file : null);
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
        const state = await readState();
        state.autoRotate = body.enabled === true;
        await writeState(state);
        json(res, 200, { autoRotate: state.autoRotate });
        return;
      }
      if (action === 'clear-cooldown') {
        if (typeof body.file === 'string') await clearBench(body.file);
        json(res, 200, { cleared: body.file ?? null });
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
        const moved = await rotateAwayFrom(failed, payload.failure);
        if (moved === undefined) {
          ctx.logger.warn(
            'dsh-workbuddy-switcher: quota failure with no other healthy account; leaving the error to surface',
          );
          return next();
        }
        ctx.logger.info(
          `dsh-workbuddy-switcher: rotated to ${moved.uid.slice(0, 8)} after a quota failure`,
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

  // The rotation needs the agent's failure hook, which only exists once the
  // agent service is present.
  ctx.inject(['agents'], () => installRotation(ctx));
}
