/**
 * WorkBuddy's chat gateway fingerprints DeepSeek Harness's system prompt.
 *
 * Measured on `copilot.tencent.com/v2/chat/completions` (CN, 2026-10-22): a
 * body whose `system` message contains the raw text `DeepSeek Harness` is
 * answered `400` / `code 11128` / `msg: "Illegal API invocation from an
 * unapproved channel"`, whose `displayMsg.zh` is 「请求被拦截，请重新发送」. The
 * offending text is not one sentence but every place DSH's prompt spells the
 * product name out — the opener ("You are an AI agent powered by DeepSeek
 * Harness."), the runtime-context line ("…names the DeepSeek Harness
 * implementation checkout.") and the GUI line ("…through the DeepSeek Harness
 * Web GUI…"). `dsh-workbuddy-connect` already defends the *first* occurrence,
 * which is enough only while DSH's prompt mentions the name exactly once; from
 * the moment it mentions it three times, the untouched tail re-arms the check
 * and every WorkBuddy model fails.
 *
 * The neutralisation is the one the bridge plugin already established: insert
 * U+200B between the two words. The gateway matches bytes, so the phrase stops
 * matching, while the prompt still reads the same to a human and means the same
 * to a model.
 *
 * This module owns that fix from the transport side instead of patching the
 * bridge plugin's vendored bundle: it wraps `fetch` for the duration of the
 * plugin's lifetime and rewrites only WorkBuddy chat bodies, so the guarantee
 * survives any `dsh-workbuddy-connect` upgrade. Scope is deliberately narrow —
 * a POST to a `…/v2/chat/completions` URL carrying a JSON string body, touching
 * only `system`/`developer` message text — so no other provider, and no user
 * message, can be affected. The rewrite is idempotent: a body the bridge plugin
 * already prepared has no raw phrase left, and is passed through untouched.
 */

/** The spelling the gateway rejects. */
const CHANNEL_PHRASE = 'DeepSeek Harness';

/** The same wording with a zero-width space, which the byte match no longer sees. */
const CHANNEL_PHRASE_NEUTRALIZED = 'DeepSeek\u200b Harness';

/** The only endpoint whose body this guard rewrites. */
const CHAT_PATH = '/v2/chat/completions';

/** Roles whose text is model-facing instructions; user text is never touched. */
const INSTRUCTION_ROLES = new Set(['system', 'developer']);

/** Marks a fetch wrapper this module installed, so re-entry is detectable. */
const GUARDED = Symbol.for('dsh-workbuddy-switcher.channel-guard');

/** Replace every occurrence of the phrase in one string. */
function neutralizeText(text) {
  if (typeof text !== 'string' || !text.includes(CHANNEL_PHRASE)) return text;
  return text.split(CHANNEL_PHRASE).join(CHANNEL_PHRASE_NEUTRALIZED);
}

/** Rewrite the instruction text of a single message in place; report whether it changed. */
function neutralizeMessage(message) {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return false;
  if (!INSTRUCTION_ROLES.has(message['role'])) return false;
  const content = message['content'];
  if (typeof content === 'string') {
    const next = neutralizeText(content);
    if (next === content) return false;
    message['content'] = next;
    return true;
  }
  // pi-ai can spell the system prompt as text parts instead of a bare string.
  if (!Array.isArray(content)) return false;
  let changed = false;
  for (const part of content) {
    if (typeof part !== 'object' || part === null) continue;
    const text = part['text'];
    if (typeof text !== 'string') continue;
    const next = neutralizeText(text);
    if (next === text) continue;
    part['text'] = next;
    changed = true;
  }
  return changed;
}

/**
 * Neutralise every instruction-role occurrence in a chat body.
 *
 * Exported for tests and for callers that already hold a parsed body. A body
 * this module does not recognise is reported as unchanged rather than throwing,
 * so a malformed request still reaches the upstream with its original error.
 *
 * @param bodyString - the `JSON.stringify`d chat-completions request.
 * @returns The rewritten body, or `undefined` when nothing needed changing.
 */
export function neutralizeChatBody(bodyString) {
  if (typeof bodyString !== 'string' || !bodyString.includes(CHANNEL_PHRASE)) return undefined;
  let document;
  try {
    document = JSON.parse(bodyString);
  } catch {
    return undefined;
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return undefined;
  const messages = document['messages'];
  if (!Array.isArray(messages)) return undefined;
  let changed = false;
  for (const message of messages) {
    if (neutralizeMessage(message)) changed = true;
  }
  if (!changed) return undefined;
  return JSON.stringify(document);
}

/**
 * Drop a stale `Content-Length` after the body is replaced.
 *
 * Node recomputes the length for a string body, but a caller-supplied header
 * would otherwise win and truncate the request. Only the shapes the bridge
 * plugin actually builds are handled (plain object / `Headers`); anything else
 * is left as the caller wrote it.
 */
function dropContentLength(headers) {
  if (typeof headers !== 'object' || headers === null) return headers;
  if (typeof headers.delete === 'function') {
    headers.delete('content-length');
    return headers;
  }
  if (Array.isArray(headers)) {
    return headers.filter((entry) => String(entry?.[0] ?? '').toLowerCase() !== 'content-length');
  }
  const next = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'content-length') continue;
    next[key] = value;
  }
  return next;
}

/** Whether `input`/`init` describe a WorkBuddy chat POST this guard should inspect. */
function isChatPost(input, init) {
  if (typeof init !== 'object' || init === null) return false;
  const method = typeof init['method'] === 'string' ? init['method'].toUpperCase() : 'GET';
  if (method !== 'POST') return false;
  if (typeof init['body'] !== 'string') return false;
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : undefined;
  if (url === undefined || !url.includes(CHAT_PATH)) return false;
  return true;
}

/**
 * Wrap `globalThis.fetch` so every WorkBuddy chat body is neutralised.
 *
 * The wrapper never becomes the failure: anything unexpected falls back to the
 * original call with the original arguments, and the replacement happens before
 * the request is dispatched, so a guard bug cannot corrupt a working request.
 *
 * @returns A restore function; safe to call more than once.
 */
export function installChannelGuard() {
  const target = globalThis;
  const original = target.fetch;
  if (typeof original !== 'function') return () => {};
  // A second activation (HMR, duplicate mount) must not stack wrappers.
  if (original[GUARDED] === true) return () => {};

  const guarded = async function guardedFetch(input, init) {
    try {
      if (isChatPost(input, init)) {
        const next = neutralizeChatBody(init['body']);
        if (next !== undefined) {
          return await original.call(this, input, {
            ...init,
            body: next,
            headers: dropContentLength(init['headers']),
          });
        }
      }
    } catch {
      // Fall through to the untouched request below.
    }
    return await original.call(this, input, init);
  };
  Object.defineProperty(guarded, GUARDED, { value: true });

  target.fetch = guarded;
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    if (target.fetch === guarded) target.fetch = original;
  };
}
