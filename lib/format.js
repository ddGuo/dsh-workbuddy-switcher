/**
 * Credential document shapes shared by the switcher's host half, the capture
 * tool and the archive migration.
 *
 * `dsh-workbuddy-connect` reads two different shapes:
 *
 * - the **desktop** shape (`{auth, account}` or flat), parsed by
 *   `parseWorkBuddyAuth` — this is what an `authFile` override must contain;
 * - its **own copy** shape (`{version:1, credential}`), parsed by
 *   `parseOwnDocument` — this lives at `$DSH_HOME/.workbuddy-auth.json` and is
 *   written by the plugin after a token refresh.
 *
 * An archive pointed at through `WORKBUDDY_AUTH_FILE` is read by the *desktop*
 * parser, so archives must be written in the desktop shape. Writing the own
 * shape there makes the plugin parse `undefined` and treat the variant as
 * signed out, which hides the whole model group.
 */

/** Expiry fields accept seconds or milliseconds; the plugin's own rule. */
export function expiryToMs(value) {
  if (typeof value !== 'number' || value <= 0) return 0;
  return value > 0xe8d4a51000 ? value : value * 1e3;
}

/** Whether a domain belongs to the international product. */
export function isGlobalDomain(domain) {
  const lowered = String(domain ?? '').trim().toLowerCase();
  return lowered === 'workbuddy.ai' || lowered.endsWith('.workbuddy.ai');
}

/**
 * Serialize a canonical credential into the desktop shape the plugin reads
 * through an `authFile` override.
 *
 * @param credential - canonical credential, as the capture tool produces it.
 * @returns the JSON document to write.
 */
export function toDesktopDocument(credential) {
  const auth = {
    accessToken: credential.accessToken,
    refreshToken: credential.refreshToken,
    expiresAt: credential.expiresAtMs,
    domain: credential.domain ?? '',
  };
  if (typeof credential.refreshExpiresAtMs === 'number' && credential.refreshExpiresAtMs > 0) {
    auth.refreshExpiresAt = credential.refreshExpiresAtMs;
  }
  const account = { uid: credential.uid ?? '' };
  if (credential.nickname) account.nickname = credential.nickname;
  if (credential.enterpriseId) account.enterpriseId = credential.enterpriseId;
  return { auth, account };
}

/**
 * Read either on-disk shape into one canonical credential.
 *
 * @param document - parsed JSON document.
 * @returns the canonical credential, or undefined when it carries no token.
 */
export function canonicalFromDocument(document) {
  if (typeof document !== 'object' || document === null) return undefined;

  // Own-copy shape written by the plugin.
  if (typeof document.credential === 'object' && document.credential !== null) {
    const stored = document.credential;
    if (typeof stored.accessToken !== 'string' || stored.accessToken === '') return undefined;
    const credential = {
      accessToken: stored.accessToken,
      refreshToken: typeof stored.refreshToken === 'string' ? stored.refreshToken : '',
      expiresAtMs: expiryToMs(stored.expiresAtMs),
      domain: typeof stored.domain === 'string' ? stored.domain : '',
      uid: typeof stored.uid === 'string' ? stored.uid : '',
    };
    if (typeof stored.refreshExpiresAtMs === 'number' && stored.refreshExpiresAtMs > 0) {
      credential.refreshExpiresAtMs = expiryToMs(stored.refreshExpiresAtMs);
    }
    if (typeof stored.enterpriseId === 'string' && stored.enterpriseId !== '') {
      credential.enterpriseId = stored.enterpriseId;
    }
    if (typeof stored.nickname === 'string' && stored.nickname !== '') {
      credential.nickname = stored.nickname;
    }
    return credential;
  }

  // Desktop shape: nested `{auth, account}` or flat.
  const auth = typeof document.auth === 'object' && document.auth !== null ? document.auth : document;
  const identity =
    typeof document.account === 'object' && document.account !== null ? document.account : document;
  if (typeof auth.accessToken !== 'string' || auth.accessToken === '') return undefined;
  const credential = {
    accessToken: auth.accessToken,
    refreshToken: typeof auth.refreshToken === 'string' ? auth.refreshToken : '',
    expiresAtMs: expiryToMs(auth.expiresAt),
    domain: typeof auth.domain === 'string' ? auth.domain : '',
    uid: typeof identity.uid === 'string' ? identity.uid : '',
  };
  if (typeof auth.refreshExpiresAt === 'number' && auth.refreshExpiresAt > 0) {
    credential.refreshExpiresAtMs = expiryToMs(auth.refreshExpiresAt);
  }
  if (typeof identity.enterpriseId === 'string' && identity.enterpriseId !== '') {
    credential.enterpriseId = identity.enterpriseId;
  }
  if (typeof identity.nickname === 'string' && identity.nickname !== '') {
    credential.nickname = identity.nickname;
  }
  return credential;
}
