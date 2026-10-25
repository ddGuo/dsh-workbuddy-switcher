import assert from 'node:assert/strict';
import test from 'node:test';

import {
  accountLabel,
  canonicalFromDocument,
  phoneLabel,
  toDesktopDocument,
  withArchivePhone,
} from '../lib/format.js';

// The phone label is the only account identity the panel shows, so it is the one
// place where "what counts as a phone" has to be pinned. WorkBuddy hands out the
// masked form only; a full number must never become a label.
test('a masked WorkBuddy phone is accepted and normalised', () => {
  assert.equal(phoneLabel('180****0331'), '180****0331');
  assert.equal(phoneLabel('134****9454'), '134****9454');
  // Country prefix and separators vary by build.
  assert.equal(phoneLabel('+86 134****9454'), '134****9454');
  assert.equal(phoneLabel('+86134****9454'), '134****9454');
  assert.equal(phoneLabel('86-134****9454'), '134****9454');
  // Padding is not part of the identity.
  assert.equal(phoneLabel('  134****9454  '), '134****9454');
  // Widely varying mask widths still collapse to the canonical four stars.
  assert.equal(phoneLabel('134***9454'), '134****9454');
  assert.equal(phoneLabel('134******9454'), '134****9454');
});

test('a full phone number is rejected rather than rendered', () => {
  for (const value of ['13412349454', '+8613412349454', '134 1234 9454', '134-1234-9454']) {
    assert.equal(phoneLabel(value), undefined, `${value} must not become a label`);
  }
});

test('non-phone identity values are rejected', () => {
  for (const value of ['', '   ', 'alice', 'a@b.c', '180****033', '180****03311', null, undefined, 42, {}]) {
    assert.equal(phoneLabel(value), undefined);
  }
});

test('the account label prefers the phone and falls back to a short uid', () => {
  assert.equal(
    accountLabel({ uid: '8bc5fd09-3730-4a8a-9182-6dadb2a1b058', nickname: '180****0331' }),
    '180****0331',
  );

  // Older archives have no phone recorded — the uid is still recognisable.
  assert.equal(
    accountLabel({ uid: '8bc5fd09-3730-4a8a-9182-6dadb2a1b058', nickname: '' }),
    '8bc5fd09…b058',
  );

  // A non-phone nickname is not a label either; it would be a different identity
  // concept sneaking into the same slot.
  assert.equal(
    accountLabel({ uid: '8bc5fd09-3730-4a8a-9182-6dadb2a1b058', nickname: 'alice' }),
    '8bc5fd09…b058',
  );

  // Degenerate inputs never render "undefined" into the UI.
  assert.equal(accountLabel({ uid: '', nickname: '' }), '—');
  assert.equal(accountLabel(undefined), '—');
  assert.equal(accountLabel({ uid: 'short' }), 'short');
});

test('the masked phone survives the archive round trip the panel reads', () => {
  // Import writes the phone as `account.nickname`; listAccounts() reads it back
  // through canonicalFromDocument. A phone that did not survive this would leave
  // the row showing a uid even though the import had it.
  const credential = {
    accessToken: 'token',
    refreshToken: 'refresh',
    expiresAtMs: 1794897148233,
    domain: 'www.workbuddy.cn',
    uid: '8bc5fd09-3730-4a8a-9182-6dadb2a1b058',
    nickname: '180****0331',
  };
  const document = toDesktopDocument(credential);
  assert.equal(document.account.nickname, '180****0331');

  const back = canonicalFromDocument(JSON.parse(JSON.stringify(document)));
  assert.equal(back.nickname, '180****0331');
  assert.equal(accountLabel(back), '180****0331');
});

test('an archive without a nickname round-trips as one, so the UI falls back', () => {
  const credential = {
    accessToken: 'token',
    refreshToken: 'refresh',
    expiresAtMs: 1794897148233,
    domain: 'www.workbuddy.cn',
    uid: '8bc5fd09-3730-4a8a-9182-6dadb2a1b058',
  };
  const document = toDesktopDocument(credential);
  assert.equal('nickname' in document.account, false, 'no empty nickname is written');
  assert.equal(accountLabel(canonicalFromDocument(document)), '8bc5fd09…b058');
});

// --- the backfill an older archive goes through -----------------------------

const UID = 'db0427fd-b175-497c-85a0-c01d8f35cb13';

function archive(overrides = {}) {
  return {
    auth: {
      accessToken: 'refreshed-by-this-plugin',
      refreshToken: 'refreshed-refresh',
      expiresAt: 1794897148233,
      domain: 'www.workbuddy.cn',
      refreshExpiresAt: 1795069948233,
    },
    account: { uid: UID },
    ...overrides,
  };
}

test('backfilling a phone never touches the tokens', () => {
  // This is the state after rotation refreshed the archive: the desktop app still
  // holds an older credential. Only the label may change.
  const original = archive();
  const patched = withArchivePhone(JSON.parse(JSON.stringify(original)), '180****0331');
  assert.ok(patched !== undefined);

  assert.equal(patched.auth.accessToken, original.auth.accessToken);
  assert.equal(patched.auth.refreshToken, original.auth.refreshToken);
  assert.equal(patched.auth.expiresAt, original.auth.expiresAt);
  assert.equal(patched.auth.refreshExpiresAt, original.auth.refreshExpiresAt);
  assert.equal(patched.account.uid, UID);
  assert.equal(patched.account.nickname, '180****0331');
});

test('a backfilled archive reads back with the phone label', () => {
  const patched = withArchivePhone(archive(), '134****9454');
  const read = canonicalFromDocument(JSON.parse(JSON.stringify(patched)));
  assert.equal(accountLabel(read), '134****9454');
});

test('backfilling is idempotent and never rewrites an already-labelled archive', () => {
  assert.equal(withArchivePhone(archive({ account: { uid: UID, nickname: '180****0331' } }), '180****0331'), undefined);
});

test('backfilling rejects a value that is not a masked phone', () => {
  for (const value of ['13412349454', 'alice', '', undefined, null]) {
    assert.equal(withArchivePhone(archive(), value), undefined, `${String(value)} must not be written`);
  }
});

test('backfilling refuses a document that carries no credential', () => {
  assert.equal(withArchivePhone({}, '180****0331'), undefined);
  assert.equal(withArchivePhone(undefined, '180****0331'), undefined);
  assert.equal(withArchivePhone({ account: { uid: UID } }, '180****0331'), undefined);
});

test('unmodelled auth fields survive the backfill', () => {
  // A future build may add a field this module does not model; a label rewrite
  // must not silently drop it.
  const original = archive();
  original.auth.sessionId = 'keep-me';
  const patched = withArchivePhone(original, '180****0331');
  assert.equal(patched.auth.sessionId, 'keep-me');
  assert.equal(patched.auth.accessToken, original.auth.accessToken);
});
