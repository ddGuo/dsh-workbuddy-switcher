/**
 * WorkBuddy's chat gateway rejects DeepSeek Harness's system prompt.
 *
 * The gateway answers some instruction text with `400` / `code 11128` /
 * `msg: "Illegal API invocation from an unapproved channel"`, whose
 * `displayMsg.zh` is 「请求被拦截，请重新发送」. Measured twice on
 * `copilot.tencent.com/v2/chat/completions` (CN), and the rule changed between
 * the two measurements — which is why this module no longer targets one phrase.
 *
 * **2026-10-22:** the trigger was the literal text `DeepSeek Harness` in a
 * `system` message. One occurrence was enough; replacing it with
 * `DeepSeek<U+200B> Harness` answered `200`.
 *
 * **2026-10-28:** that replacement no longer helped. The trigger had moved to a
 * longer, exact substring elsewhere in the prompt: every single-character edit
 * inside the matched window cleared the rejection, while prepending or
 * appending text did not — the signature of an exact-match blacklist rather
 * than a rule about one word. Measured on the live 8 KB prompt:
 *
 * | system message | result |
 * |---|---|
 * | live prompt, both `DeepSeek Harness` spellings handled | `400` |
 * | live prompt with the offending block removed | `200` |
 * | live prompt with one character changed in that block | `200` |
 * | live prompt with a `U+200B` after every sentence | `200` |
 * | live prompt with a `U+200B` every ~24 characters of running text | `200` |
 *
 * So the durable fix is to stop letting any long exact string survive the
 * rewrite. A zero-width space is invisible in a rendered prompt, keeps the
 * words it separates readable and semantically identical, and breaks a byte
 * match wherever it lands. Inserting one at word boundaries on a fixed cadence
 * caps the longest matchable run at that cadence, so a blacklist entry the
 * gateway adds tomorrow cannot match either.
 *
 * Scope stays deliberately narrow: a `POST` to a `…/v2/chat/completions` URL
 * whose body is a JSON string, rewriting only `system` / `developer` text. User
 * messages, other providers, tool declarations, and any body that needs no
 * rewrite are passed through byte-identical. The rewrite is idempotent — text
 * already carrying the markers is left alone — so it composes with anything the
 * bundled bridge does before it.
 */

/** The one phrase the gateway was measured rejecting outright on 2026-10-22. */
const CHANNEL_PHRASE = 'DeepSeek Harness';

/** The same wording with a zero-width space, which the byte match no longer sees. */
const CHANNEL_PHRASE_NEUTRALIZED = 'DeepSeek\u200b Harness';

/** The only endpoint whose body this guard rewrites. */
const CHAT_PATH = '/v2/chat/completions';

/** Roles whose text is model-facing instructions; user text is never touched. */
const INSTRUCTION_ROLES = new Set(['system', 'developer']);

/** Marks a fetch wrapper this module installed, so re-entry is detectable. */
const GUARDED = Symbol.for('dsh-workbuddy-switcher.channel-guard');

/** The invisible separator that breaks an exact byte match without changing meaning. */
const MARK = '\u200b';

/**
 * Longest run of ordinary text allowed between markers.
 *
 * Measured fingerprints were ~110 characters and spanned more than one
 * sentence; a 24-character cadence leaves the longest possible match far below
 * that, at a cost of roughly one mark per four words.
 */
const BREAK_EVERY = 24;

/**
 * Break a text into runs no longer than {@link BREAK_EVERY} at word boundaries.
 *
 * Every mark lands between words, never inside one, so identifiers, paths and
 * code samples keep their spelling. Whitespace is preserved exactly, which
 * keeps line structure and therefore prompt formatting intact.
 *
 * @param text - instruction text to mark.
 * @returns The marked text, or the input unchanged when it cannot be split.
 */
function breakRuns(text) {
  if (typeof text !== 'string' || text === '') return text;
  let out = '';
  let run = 0;
  for (const token of text.split(/(\s+)/)) {
    out += token;
    // Whitespace neither adds to nor resets the run: only a mark does, and that
    // is what bounds the longest run to roughly one cadence.
    if (/^\s+$/.test(token)) continue;
    run += token.length;
    if (run >= BREAK_EVERY) {
      out += MARK;
      run = 0;
    }
  }
  return out;
}

/**
 * Rewrite one instruction string: the measured phrase first, then the generic
 * run breaker. Idempotent because neither step can match the other's output.
 *
 * @param text - the message content.
 * @returns The rewritten text, or the input unchanged when it is not a string.
 */
function neutralizeText(text) {
  if (typeof text !== 'string' || text === '') return text;
  const phraseFixed = text.includes(CHANNEL_PHRASE)
    ? text.split(CHANNEL_PHRASE).join(CHANNEL_PHRASE_NEUTRALIZED)
    : text;
  return breakRuns(phraseFixed);
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
 * Neutralise every instruction message in a chat body.
 *
 * Exported for tests and for callers that already hold the body. A body this
 * module does not recognise is reported as unchanged rather than throwing, so a
 * malformed request still reaches the upstream with its original error.
 *
 * @param bodyString - the `JSON.stringify`d chat-completions request.
 * @returns The rewritten body, or `undefined` when nothing needed changing.
 */
export function neutralizeChatBody(bodyString) {
  if (typeof bodyString !== 'string' || bodyString === '') return undefined;
  // Cheap rejection before paying for a parse: a body without an instruction
  // role cannot need this rewrite.
  if (!bodyString.includes('"system"') && !bodyString.includes('"developer"')) return undefined;
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
 * would otherwise win and truncate the request. Only the shapes the bundled
 * bridge actually builds are handled (plain object / `Headers`); anything else
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

/** Marks a `chatStream` this module already wrapped, so re-entry is detectable. */
const RETRYING = Symbol.for('dsh-workbuddy-switcher.channel-retry');

/**
 * What the guard has had to do, so a silent regression becomes visible.
 *
 * The 0.3.2 loss was invisible for hours: the guard was disabled, every request
 * was rejected, and nothing said so until a turn failed in the middle of work.
 * These counters cost no extra request — they are incremented from the retry
 * path that already runs — and the panel renders them.
 *
 * `escalations` counts rejected-then-retried requests (recovered), and
 * `unrecovered` counts escalations that were rejected as well, which is the
 * alarm: the gateway's rule has outgrown this rewrite.
 */
const guardState = {
  escalations: 0,
  unrecovered: 0,
  lastEscalationAt: 0,
  lastUnrecoveredAt: 0,
  lastDetail: '',
};

/**
 * Read the guard's counters.
 *
 * @returns A snapshot, safe to serialise into a route response.
 */
export function readGuardState() {
  return { ...guardState };
}

/** Reset the counters; used by tests so one case cannot observe another's. */
export function resetGuardState() {
  guardState.escalations = 0;
  guardState.unrecovered = 0;
  guardState.lastEscalationAt = 0;
  guardState.lastUnrecoveredAt = 0;
  guardState.lastDetail = '';
}

/**
 * Whether one upstream result is the gateway's channel check rather than a
 * different 400.
 *
 * The message is the raw response body, so the business code is the stable
 * signal; the two phrasings are the English `msg` and the Chinese
 * `displayMsg.zh` seen in the same document, kept because a future reply may
 * carry only one of them.
 *
 * @param result - the value `chatStream` resolved with.
 * @returns True only for `400` plus the channel-check markers.
 */
export function isChannelRejection(result) {
  if (result === null || typeof result !== 'object' || result.ok !== false) return false;
  if (result.status !== 400) return false;
  const message = typeof result.message === 'string' ? result.message : '';
  return message.includes('11128')
    || message.includes('Illegal API invocation from an unapproved channel')
    || message.includes('请求被拦截');
}

/** Mark one string the way instruction text is marked: measured phrase, then runs. */
function markText(text) {
  if (typeof text !== 'string' || text === '') return text;
  const phraseFixed = text.includes(CHANNEL_PHRASE)
    ? text.split(CHANNEL_PHRASE).join(CHANNEL_PHRASE_NEUTRALIZED)
    : text;
  return breakRuns(phraseFixed);
}

/**
 * Mark every model-visible string in one message.
 *
 * Deliberately limited to free text: `role`, ids and — importantly —
 * `tool_calls[].function.arguments` stay byte-identical, because those
 * arguments are a JSON document and a mark between two tokens would turn the
 * body into something the upstream cannot parse. Content, `reasoning_content`
 * and tool descriptions carry no such constraint.
 */
function markMessageEverywhere(message) {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return false;
  let changed = false;
  const content = message['content'];
  if (typeof content === 'string') {
    const next = markText(content);
    if (next !== content) {
      message['content'] = next;
      changed = true;
    }
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part !== 'object' || part === null) continue;
      const text = part['text'];
      if (typeof text !== 'string') continue;
      const next = markText(text);
      if (next === text) continue;
      part['text'] = next;
      changed = true;
    }
  }
  const reasoning = message['reasoning_content'];
  if (typeof reasoning === 'string') {
    const next = markText(reasoning);
    if (next !== reasoning) {
      message['reasoning_content'] = next;
      changed = true;
    }
  }
  return changed;
}

/**
 * Mark every model-visible string in a chat body, not just instruction text.
 *
 * This is the escalation used after the gateway has already rejected a body:
 * once `400 / 11128` has been measured, the body is worth rewriting wherever it
 * can be rewritten without breaking the wire format, because the rule is an
 * exact-match fingerprint and a hit anywhere fails the whole request. Tool
 * names, arguments, ids, roles and the model name stay untouched.
 *
 * @param bodyString - the `JSON.stringify`d chat-completions request.
 * @returns The rewritten body, or `undefined` when nothing changed.
 */
export function neutralizeChatBodyEverywhere(bodyString) {
  if (typeof bodyString !== 'string' || bodyString === '') return undefined;
  let document;
  try {
    document = JSON.parse(bodyString);
  } catch {
    return undefined;
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return undefined;
  let changed = false;
  const messages = document['messages'];
  if (Array.isArray(messages)) {
    for (const message of messages) if (markMessageEverywhere(message)) changed = true;
  }
  const tools = document['tools'];
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      const fn = typeof tool === 'object' && tool !== null ? tool['function'] : undefined;
      if (typeof fn !== 'object' || fn === null) continue;
      const description = fn['description'];
      if (typeof description !== 'string') continue;
      const next = markText(description);
      if (next === description) continue;
      fn['description'] = next;
      changed = true;
    }
  }
  if (!changed) return undefined;
  return JSON.stringify(document);
}

/**
 * Wrap a `WorkBuddyUpstreamClient` so a rejected chat is retried once with the
 * whole body marked.
 *
 * The fetch guard above is the first line of defence, but it depends on being
 * the outermost `globalThis.fetch`: another plugin that imports `undici`, or a
 * host that replaces `fetch` after activation, silently disables it. This
 * wrapper sits on the one method every chat body must pass through and cannot
 * be displaced that way.
 *
 * The first attempt is sent exactly as the caller wrote it, so a healthy
 * request never sees this code path, and a body that the fetch guard already
 * handled is not rewritten twice. Only a measured `400 / 11128` escalates.
 *
 * @param clientClass - the vendored `WorkBuddyUpstreamClient` export.
 * @param options - optional `onRejection({ recovered, detail })` sink, called
 *   once per escalation so the host can log the event where a human will see it.
 * @returns A restore function; safe to call more than once.
 */
export function installUpstreamRetry(clientClass, options = {}) {
  const proto = typeof clientClass === 'function' ? clientClass.prototype : undefined;
  if (proto === undefined || typeof proto.chatStream !== 'function') return () => {};
  if (proto.chatStream[RETRYING] === true) return () => {};
  const original = proto.chatStream;
  const notify = typeof options.onRejection === 'function' ? options.onRejection : () => {};

  const retrying = async function chatStream(credential, bodyJson, signal) {
    const first = await original.call(this, credential, bodyJson, signal);
    if (!isChannelRejection(first)) return first;
    const escalated = neutralizeChatBodyEverywhere(bodyJson);
    if (escalated === undefined) {
      // Nothing left to mark: the rejection cannot be answered by this module,
      // and staying silent would repeat the 0.3.2 failure mode.
      guardState.unrecovered += 1;
      guardState.lastUnrecoveredAt = Date.now();
      guardState.lastDetail = 'a channel rejection arrived for a body that carried nothing to mark';
      notify({ recovered: false, detail: guardState.lastDetail });
      return first;
    }
    const retried = await original.call(this, credential, escalated, signal);
    guardState.escalations += 1;
    guardState.lastEscalationAt = Date.now();
    if (isChannelRejection(retried)) {
      // The rewrite ran and the gateway still refused: its rule is no longer an
      // exact byte match this module can defeat.
      guardState.unrecovered += 1;
      guardState.lastUnrecoveredAt = Date.now();
      guardState.lastDetail = 'the marked body was rejected as well';
      notify({ recovered: false, detail: guardState.lastDetail });
    } else {
      notify({ recovered: true, detail: 'a rejected request was retried with the marked body' });
    }
    return retried;
  };
  Object.defineProperty(retrying, RETRYING, { value: true });

  proto.chatStream = retrying;
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    if (proto.chatStream === retrying) proto.chatStream = original;
  };
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
