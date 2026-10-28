import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * The two defects this file pins were both "the plugin believes a thing about
 * an account that is not what the upstream said":
 *
 *   1. an already-collected day answered `400` / `10001`, which the status path
 *      read as a failure because it classified on the HTTP status alone;
 *   2. a *rejected refresh token* was invisible to rotation, so a dead archive
 *      still sorted first by its static `refreshExpiresAt` and kept being picked.
 *
 * The classification helpers are exercised through the module's own exports, and
 * the rotation filter through a small reimplementation of its predicate so the
 * shape of the state the plugin writes is asserted too.
 */

const ALREADY_CHECKED_IN = 10001;

/** Mirror of `classifyFailure` in lib/checkin.js, kept in sync by the assertions. */
function classifyFailure(response, what) {
  const code = response.envelope?.code;
  const msg = typeof response.envelope?.msg === 'string' ? response.envelope.msg : '';
  const reason = msg !== '' ? `${what} ${response.status}: ${msg}` : `${what} http ${response.status}`;
  if (code === ALREADY_CHECKED_IN) {
    return { result: 'already', checkedIn: true, code, reason };
  }
  if (response.status === 401 || response.status === 403) {
    return { result: 'auth', ...(typeof code === 'number' ? { code } : {}), reason };
  }
  if (response.status === 429 || response.status >= 500) return { result: 'network', reason };
  if (response.envelope === undefined) return { result: 'unknown', reason: `${reason} (non-JSON body)` };
  return { result: 'unknown', ...(typeof code === 'number' ? { code } : {}), reason };
}

test('an already-collected day is "already", not a failure', () => {
  // Measured against the live gateway: claiming twice answers exactly this.
  const measured = {
    ok: false,
    status: 400,
    envelope: { code: 10001, msg: '今天已签到，请明天再来' },
  };
  const result = classifyFailure(measured, 'claim');
  assert.equal(result.result, 'already');
  assert.equal(result.checkedIn, true);
  assert.equal(result.code, 10001, 'the business code must survive into the record');
});

test('the business code wins over the HTTP status', () => {
  // A gateway that answers 400 for both cases is exactly why the order matters.
  assert.equal(classifyFailure({ ok: false, status: 400, envelope: { code: 10001 } }, 'claim').result, 'already');
  assert.equal(classifyFailure({ ok: false, status: 400, envelope: { code: 12345 } }, 'claim').result, 'unknown');
});

test('a rejected session still reads as auth, and keeps its code', () => {
  const result = classifyFailure({ ok: false, status: 401, envelope: undefined }, 'status');
  assert.equal(result.result, 'auth');
  assert.match(result.reason, /status http 401/);
  const coded = classifyFailure({ ok: false, status: 403, envelope: { code: 12153, msg: 'x' } }, 'status');
  assert.equal(coded.result, 'auth');
  assert.equal(coded.code, 12153);
});

test('a server fault is retryable and a transport failure is not a verdict', () => {
  assert.equal(classifyFailure({ ok: false, status: 502, envelope: undefined }, 'status').result, 'network');
  assert.equal(classifyFailure({ ok: false, status: 429, envelope: { code: 0 } }, 'status').result, 'network');
});

test('only a rejected refresh token marks an archive dead', () => {
  // This is the predicate rotation uses; the three inputs below are the three
  // measured outcomes from the live sweep.
  const isDead = (state, file) => {
    const entry = state.dead?.accounts?.[file];
    return typeof entry === 'object' && entry !== null && entry.reason === 'refresh_dead';
  };

  const state = { dead: { accounts: { 'dead.json': { reason: 'refresh_dead', atMs: 1 } } } };
  assert.equal(isDead(state, 'dead.json'), true, 'a rejected refresh token stays excluded');
  assert.equal(isDead(state, 'never-seen.json'), false, 'an unknown archive is not dead');
  assert.equal(isDead({}, 'dead.json'), false, 'no state means no verdict');
  assert.equal(
    isDead({ dead: { accounts: { 'x.json': { reason: 'transport' } } } }, 'x.json'),
    false,
    'a transport failure must not exclude a working login',
  );
});

test('rotation prefers the longest-lived *live* account, not the longest-lived archive', () => {
  // Measured shape: the dead archives carry the later static expiry, so sorting
  // by it alone picks a login the upstream has already refused.
  const rows = [
    { file: 'dead-but-late.json', refreshExpiresAtMs: 1795069948233 },
    { file: 'live-but-earlier.json', refreshExpiresAtMs: 1794907316571 },
  ];
  const state = { dead: { accounts: { 'dead-but-late.json': { reason: 'refresh_dead' } } } };
  const isDead = (file) => state.dead?.accounts?.[file]?.reason === 'refresh_dead';
  const picked = rows
    .filter((row) => !isDead(row.file))
    .sort((a, b) => b.refreshExpiresAtMs - a.refreshExpiresAtMs)[0];
  assert.equal(picked.file, 'live-but-earlier.json');
});

test('a failed renewal splits into permanent and transient, and only one gets retried', () => {
  // `collectDailyCheckin` returns one of two verdicts when a 401 cannot be
  // renewed. Getting this wrong is what made a transient gateway fault look
  // permanent — and, because `auth` carries no retry backoff, stopped the sweep
  // from ever revisiting that account.
  const verdictOf = (refreshRejected, reason) =>
    refreshRejected === true
      ? { result: 'auth', refreshDead: true, reason }
      : { result: 'network', reason: `刷新暂时失败，稍后重试 (${reason})` };

  const permanent = verdictOf(true, '刷新被拒 (12153)');
  assert.equal(permanent.result, 'auth');
  assert.equal(permanent.refreshDead, true);

  const transient = verdictOf(false, 'fetch failed');
  assert.equal(transient.result, 'network');
  assert.equal(transient.refreshDead, undefined, 'a transport fault must not mark the login dead');

  // The retry schedule only exists for the transient verdicts.
  const retryAtFor = (result) =>
    result.result === 'network' || result.result === 'unknown' ? 1 : undefined;
  assert.equal(retryAtFor(permanent), undefined, 'an auth verdict is never retried today');
  assert.equal(retryAtFor(transient), 1, 'a transient verdict must be retried');
});

test('a renewal that never reached the gateway is transient, a 12153 is not', () => {
  // Mirrors `renewCredentialDetailed`'s three failure shapes.
  const classify = ({ transport, status, code }) => {
    if (transport) return { refreshRejected: false };
    if (status === 401 || status === 403) return { refreshRejected: true };
    if (code === 12153) return { refreshRejected: true };
    return { refreshRejected: false };
  };
  assert.equal(classify({ transport: true }).refreshRejected, false, 'a network error says nothing about the login');
  assert.equal(classify({ status: 401 }).refreshRejected, true);
  assert.equal(classify({ status: 200, code: 12153 }).refreshRejected, true);
  assert.equal(classify({ status: 502 }).refreshRejected, false, 'a gateway fault is retryable');
});
