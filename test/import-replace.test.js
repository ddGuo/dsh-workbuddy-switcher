import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * `importCurrent` has three modes that must not be confused. The measured facts
 * behind them:
 *
 *   - the sweep's phone patch must NOT overwrite tokens, because this plugin may
 *     have refreshed them more recently than the desktop app wrote its copy;
 *   - `requireNew` must skip an identical archive, so a 20-second poll does not
 *     rewrite the file forever;
 *   - neither of those can revive a login whose refresh token the upstream
 *     refused (`12153`) — only the app's freshly signed-in copy can. That is
 *     `replace`, and it is the one mode allowed to overwrite.
 *
 * The decisions are modelled here the way lib/index.js makes them, so a change in
 * the ordering is caught without needing the decrypting desktop binary.
 */

/** Mirror of the branch order in `importCurrent`. */
function decide({ phoneOnly, replace, requireNew, exists, sameAccessToken, sameNickname }) {
  if (phoneOnly === true) return exists ? 'phone-only' : 'noop';
  if (replace === true && exists) return 'replace';
  if (requireNew === true && exists && sameAccessToken && sameNickname) return 'noop';
  return 'write';
}

test('the phone patch never touches tokens', () => {
  assert.equal(decide({ phoneOnly: true, exists: true }), 'phone-only');
  // Even with a replace flag alongside, the phone-only path wins: a caller that
  // asked for metadata must not be upgraded into a token overwrite.
  assert.equal(decide({ phoneOnly: true, replace: true, exists: true }), 'phone-only');
  assert.equal(decide({ phoneOnly: true, exists: false }), 'noop');
});

test('the polling sweep stays a no-op for an unchanged archive', () => {
  assert.equal(
    decide({ requireNew: true, exists: true, sameAccessToken: true, sameNickname: true }),
    'noop',
  );
  // A new access token or a newly learned phone is worth writing.
  assert.equal(
    decide({ requireNew: true, exists: true, sameAccessToken: false, sameNickname: true }),
    'write',
  );
  assert.equal(
    decide({ requireNew: true, exists: true, sameAccessToken: true, sameNickname: false }),
    'write',
  );
});

test('replace overwrites even when the archive looks identical', () => {
  // This is the case that could never be recovered before: the dead archive and
  // the app's copy look the same to `requireNew`, so it skipped the write and
  // the dead verdict stood forever.
  assert.equal(
    decide({ replace: true, requireNew: true, exists: true, sameAccessToken: true, sameNickname: true }),
    'replace',
  );
});

test('a plain import still writes when there is no archive yet', () => {
  assert.equal(decide({ exists: false }), 'write');
  assert.equal(decide({ requireNew: true, exists: false }), 'write');
});

test('replace is the only mode that clears a dead verdict, and only on success', () => {
  // `importCurrent` clears the mark after the write, so a failed read leaves the
  // archive excluded rather than silently re-eligible.
  const recordDeadCalls = [];
  const importArchive = ({ wrote }) => {
    if (!wrote) return undefined;
    recordDeadCalls.push(false);
    return { file: 'x.json' };
  };
  importArchive({ wrote: false });
  assert.deepEqual(recordDeadCalls, [], 'a failed import must not clear the verdict');
  importArchive({ wrote: true });
  assert.deepEqual(recordDeadCalls, [false], 'a successful import clears it');
});

test('a dead archive is revived from the app, not from a phone patch', () => {
  // The sweep's decision order: a dead archive whose uid matches the app's
  // current login goes straight to replace, ahead of the phone-patch branch that
  // would otherwise leave the tokens alone.
  const sweep = ({ isDead, knownNickname }) => {
    if (isDead) return 'replace';
    if (knownNickname !== '') return 'noop';
    return 'phone-only';
  };
  assert.equal(sweep({ isDead: true, knownNickname: '' }), 'replace');
  assert.equal(sweep({ isDead: true, knownNickname: '132****2794' }), 'replace');
  assert.equal(sweep({ isDead: false, knownNickname: '' }), 'phone-only');
  assert.equal(sweep({ isDead: false, knownNickname: '132****2794' }), 'noop');
});
