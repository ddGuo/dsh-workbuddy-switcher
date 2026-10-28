/**
 * Daily check-in ("每日签到") for archived WorkBuddy accounts.
 *
 * WorkBuddy hands out 100 credits once a day through two billing endpoints on
 * the same gateway the plugin already talks to for credit balances:
 *
 * ```text
 * POST /v2/billing/meter/checkin-activity-status   → today's state (read-only)
 * POST /v2/billing/meter/daily-checkin             → claim, idempotent per day
 * ```
 *
 * Both take the archive's own `accessToken`, so this needs no desktop app, no
 * second sign-in and no extra secret: an account that can serve a model request
 * can also collect its own daily credits.
 *
 * Three measured facts shape the code below:
 *
 * - **The claim is idempotent.** A second call on the same day answers
 *   `400` / `code 10001` ("今天已签到，请明天再来") and grants nothing. Retrying
 *   after an ambiguous network failure is therefore safe, which is what lets the
 *   scheduler keep the state machine trivial.
 * - **An expired session answers with HTML**, not JSON: APISIX returns a 401
 *   page. Parsing a body unconditionally would turn "token expired" into
 *   `Unexpected token '<'`, which is useless in a log, so every read is
 *   content-type aware.
 * - **The activity window is seasonal.** `active: false` outside the window;
 *   that is not a failure and must not be retried in a loop.
 *
 * The refresh endpoint is the one write this module performs beyond the claim.
 * It rotates the refresh token on every call, and the previous refresh token
 * keeps working afterwards (verified against a live account), so an accidental
 * double refresh degrades to a wasted request rather than a dead login.
 */
import { copyFile, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { canonicalFromDocument, isGlobalDomain, toDesktopDocument } from './format.js';

/** The billing gateway the desktop app itself uses for this account's region. */
const CN_BILLING_BASE = 'https://www.codebuddy.cn';
/** The chat gateway; it answers the refresh endpoint and mirrors billing. */
const CN_CHAT_BASE = 'https://copilot.tencent.com';
/** The identity the official CLI presents; the gateway splits catalogues on it. */
const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2';
/** Per-request ceiling. The whole sweep has its own budget on top of this. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Business code the claim endpoint returns when the day is already collected. */
const ALREADY_CHECKED_IN = 10001;

/**
 * Headers the billing endpoints accept.
 *
 * This is the same set `dsh-workbuddy-connect` sends for its balance read
 * (`billingHeaders`), which is the point: the identity headers are what lets an
 * enterprise archive read its own tenant's data instead of a personal view.
 *
 * @param credential - the archive's canonical credential.
 * @returns headers for a billing POST.
 */
function billingHeaders(credential) {
  const headers = {
    Authorization: `Bearer ${credential.accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (credential.uid !== '') headers['X-User-Id'] = credential.uid;
  if (typeof credential.enterpriseId === 'string' && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId;
    headers['X-Tenant-Id'] = credential.enterpriseId;
  }
  if (credential.domain !== '') headers['X-Domain'] = credential.domain;
  return headers;
}

/**
 * POST JSON and classify the answer without assuming it is JSON.
 *
 * @param url - absolute endpoint.
 * @param headers - request headers.
 * @param body - request payload.
 * @returns `{ ok, status, envelope, text }`; `envelope` is undefined when the
 *   body was not JSON (the 401 HTML page, a proxy error page, an empty 204).
 */
async function postJson(url, headers, body, signal) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? {}),
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
  });
  const text = await response.text();
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    envelope = undefined;
  }
  return { ok: response.ok, status: response.status, envelope, text };
}

/**
 * Today's date in the zone the check-in day is measured in.
 *
 * The upstream switches to a new day at 00:00 UTC+8 regardless of where the
 * machine is, so the local clock is the wrong ruler for a traveller and for
 * anyone whose clock is off. `Intl` gives the zone's calendar date without
 * depending on the host's own time-zone setting.
 *
 * @returns `YYYY-MM-DD`.
 */
export function shanghaiDay() {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    // A runtime without the full ICU data falls back to the host's calendar;
    // a day of skew there only delays a retry by one sweep.
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * Whether a check-in is even applicable to this archive.
 *
 * The activity lives on the CN billing gateway only. An international archive
 * (`*.workbuddy.ai`) has no such endpoint, and asking it would produce a
 * misleading "failed" badge for an account that is simply on the other product.
 *
 * @param credential - canonical credential.
 * @returns false for international archives.
 */
export function checkinApplicable(credential) {
  return !isGlobalDomain(credential.domain);
}

/**
 * Read today's check-in state. Read-only; safe to call at any frequency.
 *
 * @param credential - canonical credential.
 * @param signal - optional abort signal.
 * @returns the raw envelope, or a classified failure.
 */
async function readStatus(credential, signal) {
  return postJson(
    `${CN_BILLING_BASE}/v2/billing/meter/checkin-activity-status`,
    billingHeaders(credential),
    {},
    signal,
  );
}

/** Whether the envelope reports success (`code: 0`). */
function envelopeOk(response) {
  return response.ok && response.envelope?.code === 0;
}

/**
 * Turn one request outcome into a scheduler-facing result.
 *
 * The categories exist because the reaction differs, not for display: `auth`
 * needs a token refresh, `network` needs a retry later today, `inactive` needs
 * silence until the activity reopens, and `already`/`claimed` need nothing more
 * until tomorrow. Collapsing them into "failed" would either hammer the upstream
 * or hide a dead login behind a retry schedule.
 *
 * @param category - one of the result kinds.
 * @param detail - fields merged into the result.
 * @returns the result record.
 */
function outcome(category, detail = {}) {
  return { result: category, day: shanghaiDay(), ...detail };
}

/**
 * Classify a failed status/claim response.
 *
 * The business code is checked before the HTTP status, because the gateway
 * reports "already collected today" as `400` / `10001` — the same status class
 * that a malformed request produces. Reading only the status turned a settled
 * account into 「签到失败 · 异常」 and, worse, hid it behind a retry that could
 * never succeed.
 *
 * @param response - output of {@link postJson}.
 * @param what - `status` or `claim`, for the recorded reason.
 * @returns a classified result.
 */
function classifyFailure(response, what) {
  const code = response.envelope?.code;
  const msg = typeof response.envelope?.msg === 'string' ? response.envelope.msg : '';
  const reason = msg !== '' ? `${what} ${response.status}: ${msg}` : `${what} http ${response.status}`;
  // The day's credits are already granted. Nothing failed, and nothing should
  // be retried: this is the same end state as claiming it here.
  if (code === ALREADY_CHECKED_IN) {
    return outcome('already', { checkedIn: true, code, reason });
  }
  if (response.status === 401 || response.status === 403) {
    return outcome('auth', { ...(typeof code === 'number' ? { code } : {}), reason });
  }
  if (response.status === 429 || response.status >= 500) {
    return outcome('network', { reason });
  }
  if (response.envelope === undefined) {
    return outcome('unknown', { reason: `${reason} (non-JSON body)` });
  }
  return outcome('unknown', { ...(typeof code === 'number' ? { code } : {}), reason });
}

/**
 * Fold the status payload into the fields the panel renders.
 *
 * @param data - `envelope.data` from the status endpoint.
 * @returns the interesting subset, with defensive defaults.
 */
function statusFields(data) {
  const value = typeof data === 'object' && data !== null ? data : {};
  return {
    active: value.active === true,
    checkedIn: value.today_checked_in === true,
    dailyCredit: typeof value.daily_credit === 'number' ? value.daily_credit : 0,
    streakDays: typeof value.streak_days === 'number' ? value.streak_days : 0,
    totalCredits: typeof value.total_credits === 'number' ? value.total_credits : 0,
    season: typeof value.season === 'number' ? value.season : undefined,
    endTime: typeof value.end_time === 'string' ? value.end_time : undefined,
    weekCheckedInDays: typeof value.week_checkin_days === 'number' ? value.week_checkin_days : undefined,
  };
}

/**
 * Collect one account's daily credits.
 *
 * The flow is query-then-claim, never claim-then-hope: the claim is idempotent,
 * but skipping a pointless write keeps the request count down and makes the
 * "already collected" case distinguishable from "collected just now" in the UI.
 *
 * A `401` triggers exactly one token refresh and one retry — the archive's
 * access token is only refreshed by whoever points the provider at it, so an
 * idle account in the pool would otherwise stay expired forever. The refreshed
 * token is written back through {@link persistRefreshed} so the next sweep, and
 * a later manual switch, both use the fresh one.
 *
 * @param credential - canonical credential for the archive.
 * @param options - `dryRun` skips the claim; `archivePath` enables writing a
 *   refreshed token back to disk.
 * @returns a result record for the state file and the panel.
 */
export async function collectDailyCheckin(credential, options = {}) {
  const { archivePath, dryRun = false, signal } = options;
  if (!checkinApplicable(credential)) {
    return outcome('region', { reason: '国际版没有签到活动' });
  }

  let current = credential;
  let refreshed = false;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const statusResponse = await readStatus(current, signal).catch((error) => ({
      ok: false,
      status: 0,
      envelope: undefined,
      text: error instanceof Error ? error.message : String(error),
    }));

    if (statusResponse.status === 0) {
      return outcome('network', { reason: `查询失败: ${statusResponse.text}` });
    }
    if (statusResponse.status === 401 || statusResponse.status === 403) {
      const renew = attempt === 0 ? await renewCredentialDetailed(current, archivePath) : { renewed: undefined, refreshRejected: false, reason: '' };
      if (renew.renewed === undefined) {
        // Three different situations arrive here, and only one is permanent:
        //
        //   refresh rejected (12153)  → the login is gone; retrying is pointless
        //   transport / gateway fault → the login is fine; retry on the next sweep
        //   no refresh token stored   → treat as permanent, nothing to renew with
        //
        // Collapsing them into 「令牌失效」 is what made a working pool look dead,
        // and marking a transport failure permanent also stopped the retry: an
        // `auth` verdict gets no backoff entry, so the account was never visited
        // again that day. The permanent case keeps the `auth` verdict — and now
        // carries `refreshDead` so rotation can stop picking it — while the
        // transient case becomes `network`, which the sweep retries.
        const classified = classifyFailure(statusResponse, 'status');
        if (renew.refreshRejected === true) {
          return { ...classified, result: 'auth', refreshDead: true, reason: renew.reason ?? classified.reason };
        }
        return {
          ...classified,
          result: 'network',
          reason: `刷新暂时失败，稍后重试 (${renew.reason || 'no detail'})`,
        };
      }
      current = renew.renewed;
      refreshed = true;
      continue;
    }
    if (!envelopeOk(statusResponse)) return classifyFailure(statusResponse, 'status');

    const fields = statusFields(statusResponse.envelope.data);
    if (!fields.active) {
      return outcome('inactive', {
        ...fields,
        reason: fields.endTime === undefined ? '签到活动未开启' : `签到活动未开启（本季至 ${fields.endTime}）`,
      });
    }
    if (fields.checkedIn) return outcome('already', { ...fields, credit: fields.dailyCredit });
    if (dryRun) return outcome('pending', { ...fields, reason: 'dry-run' });

    const claimResponse = await postJson(
      `${CN_BILLING_BASE}/v2/billing/meter/daily-checkin`,
      billingHeaders(current),
      {},
      signal,
    );
    const code = claimResponse.envelope?.code;
    const msg = typeof claimResponse.envelope?.msg === 'string' ? claimResponse.envelope.msg : '';

    if (envelopeOk(claimResponse)) {
      const data = claimResponse.envelope.data ?? {};
      return outcome('claimed', {
        ...fields,
        credit: typeof data.credit === 'number' ? data.credit : fields.dailyCredit,
        streakDays: typeof data.streak_days === 'number' ? data.streak_days : fields.streakDays,
        checkedIn: true,
        ...(refreshed ? { refreshed: true } : {}),
      });
    }
    // Another path (the app itself, a concurrent sweep) collected it between the
    // query and the claim. That is the same end state as claiming it here.
    if (code === ALREADY_CHECKED_IN) {
      return outcome('already', { ...fields, checkedIn: true, credit: fields.dailyCredit });
    }
    if (claimResponse.status === 401 || claimResponse.status === 403) {
      return outcome('auth', { ...fields, reason: `claim http ${claimResponse.status}: ${msg}` });
    }
    return outcome('unknown', {
      ...fields,
      ...(typeof code === 'number' ? { code } : {}),
      reason: `${claimResponse.status}: ${msg || '领取失败'}`,
    });
  }

  return outcome('auth', { reason: '令牌刷新后仍被拒绝' });
}

/**
 * Refresh one archive's access token and, when allowed, persist it.
 *
 * The refresh endpoint lives on the chat gateway and authenticates with the
 * *refresh* token in a header — the same wire shape `dsh-workbuddy-connect`
 * uses, which is what keeps the two from drifting.
 *
 * The rotated refresh token must be written back: the upstream issues a new one
 * on every call, and although the previous one kept working in a measured case,
 * depending on that is not a promise anyone made. Writing back keeps the archive
 * self-consistent whichever way the server behaves.
 *
 * @param credential - the credential that was rejected.
 * @param archivePath - archive file to update, when the caller allows a write.
 * @returns the renewed credential, or undefined when the refresh failed.
 */
export async function renewCredential(credential, archivePath) {
  const { renewed } = await renewCredentialDetailed(credential, archivePath);
  return renewed;
}

/**
 * Refresh one archive's access token, reporting *why* it failed.
 *
 * {@link renewCredential} cannot tell its caller whether the login is gone or
 * the request merely failed, and the two need different answers: a dead refresh
 * token is permanent until the user signs in again, while a transport blip is
 * worth retrying on the next sweep. The caller classifies on `refreshRejected`.
 *
 * @param credential - the credential that was rejected.
 * @param archivePath - archive file to update, when the caller allows a write.
 * @returns `{ renewed, refreshRejected, reason }`; `renewed` is undefined on failure.
 */
export async function renewCredentialDetailed(credential, archivePath) {
  if (typeof credential.refreshToken !== 'string' || credential.refreshToken === '') {
    return { renewed: undefined, refreshRejected: true, reason: '存档里没有刷新令牌' };
  }
  let response;
  try {
    response = await fetch(`${CN_CHAT_BASE}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers: {
        'X-Refresh-Token': credential.refreshToken,
        'X-Auth-Refresh-Source': 'workbuddy',
        Accept: 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
        Origin: CN_BILLING_BASE,
        Referer: `${CN_BILLING_BASE}/`,
        'User-Agent': CLIENT_UA,
        ...(credential.enterpriseId === undefined || credential.enterpriseId === ''
          ? {}
          : { 'X-Enterprise-Id': credential.enterpriseId }),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // Nothing was decided upstream: this is a transport failure, not a verdict
    // on the login.
    return {
      renewed: undefined,
      refreshRejected: false,
      reason: `刷新请求失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const text = await response.text().catch(() => '');
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    // A 401 answered with an APISIX HTML page means the token was refused; any
    // other non-JSON answer is a gateway problem worth retrying.
    const rejected = response.status === 401 || response.status === 403;
    return {
      renewed: undefined,
      refreshRejected: rejected,
      reason: `刷新被拒 (http ${response.status}, non-JSON)`,
    };
  }
  // 12153 is the measured "refresh token is invalid" code: the login is gone.
  const rejected = !response.ok || envelope?.code === 12153;
  if (rejected) {
    return {
      renewed: undefined,
      refreshRejected: envelope?.code === 12153 || response.status === 401 || response.status === 403,
      reason: `刷新被拒 (${envelope?.code ?? response.status}): ${String(envelope?.msg ?? '').slice(0, 80)}`,
    };
  }
  if (envelope?.code !== 0) {
    return { renewed: undefined, refreshRejected: false, reason: `刷新异常 code ${envelope?.code}` };
  }
  const data = typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : {};
  if (typeof data.accessToken !== 'string' || data.accessToken === '') {
    return { renewed: undefined, refreshRejected: false, reason: '刷新响应缺少 accessToken' };
  }

  const renewed = {
    ...credential,
    accessToken: data.accessToken,
    ...(typeof data.refreshToken === 'string' && data.refreshToken !== ''
      ? { refreshToken: data.refreshToken }
      : {}),
    ...(typeof data.expiresIn === 'number' && data.expiresIn > 0
      ? { expiresAtMs: Date.now() + data.expiresIn * 1000 }
      : {}),
    ...(typeof data.refreshExpiresIn === 'number' && data.refreshExpiresIn > 0
      ? { refreshExpiresAtMs: Date.now() + data.refreshExpiresIn * 1000 }
      : {}),
  };
  if (typeof archivePath === 'string' && archivePath !== '') {
    await persistRefreshed(archivePath, credential.accessToken, renewed).catch(() => false);
  }
  return { renewed, refreshRejected: false, reason: '' };
}

/**
 * Write a renewed credential back to its archive, atomically and defensively.
 *
 * Two guards make this safe next to `dsh-workbuddy-connect`, which refreshes and
 * rewrites the *selected* archive on its own:
 *
 * - the file is re-read first and the write is abandoned when its access token
 *   is no longer the one this refresh started from, so a concurrent writer wins
 *   instead of being clobbered by a stale token;
 * - the replacement is a temp file plus `rename`, so a crash mid-write leaves the
 *   old archive intact rather than a truncated one.
 *
 * @param path - archive file.
 * @param previousAccessToken - the token the refresh was issued against.
 * @param renewed - the credential to persist.
 * @returns whether the write happened.
 */
export async function persistRefreshed(path, previousAccessToken, renewed) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return false;
  }
  const onDisk = canonicalFromDocument(JSON.parse(text));
  if (onDisk === undefined || onDisk.accessToken !== previousAccessToken) return false;

  const temporary = join(dirname(path), `.${basename(path)}.checkin-tmp`);
  await writeFile(temporary, `${JSON.stringify(toDesktopDocument(renewed), null, 2)}\n`, { mode: 384 });
  // A copy of the pre-refresh archive, so a bad refresh can be undone by hand.
  await copyFile(path, `${path}.bak`).catch(() => undefined);
  await rename(temporary, path);
  return true;
}
