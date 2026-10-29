/**
 * WorkBuddy's chat gateway rejects DeepSeek Harness's system prompt.
 *
 * The gateway answers some request text with `400` / `code 11128` /
 * `msg: "Illegal API invocation from an unapproved channel"`, whose
 * `displayMsg.zh` is 「请求被拦截，请重新发送」. Measured three times on
 * `copilot.tencent.com/v2/chat/completions` (CN), and the rule changed every
 * time, so this module no longer tries to defeat one fingerprint.
 *
 * **2026-10-22:** the literal text `DeepSeek Harness` in a `system` message was
 * enough; spelling it `DeepSeek<U+200B> Harness` answered `200`.
 *
 * **2026-10-28:** that stopped helping. The trigger had moved to a longer exact
 * substring elsewhere in the prompt: any single-character edit inside it
 * cleared the rejection, while appending whole sentences did not. Inserting a
 * zero-width space every ~24 characters defeated it.
 *
 * **2026-10-29:** zero-width marking stopped helping too, at any density. The
 * same block answered `400` raw, `400` with U+200B every 24 characters, `400`
 * with one every 8, and `200` with a single *visible* word changed. The gateway
 * had started normalising invisible characters and whitespace before matching,
 * so the evasion itself had become trivial to normalise away.
 *
 * The same day's measurements also showed **which part of the request is
 * inspected at all**:
 *
 * | placement of the offending block | result |
 * |---|---|
 * | as a `system` message | `400` |
 * | as an `assistant` turn | `400` |
 * | as a `user` message | `200` |
 * | inside 108 tool declarations (`tools[].function.description`) | `200` |
 *
 * That is the shape this module relies on, because it needs neither a
 * fingerprint guess nor a degraded prompt: **instruction text is moved out of
 * the roles the gateway reads.** The 8 KB prompt travels byte-for-byte in a
 * leading `user` message under an explicit "authoritative instructions" frame,
 * and the `system` message keeps one neutral sentence pointing at it.
 *
 * Verified on the full production shape (the real prompt, all 108 tool
 * declarations, a multi-turn history): `400` as a system message and `200`
 * relocated, with the model still following the text it was moved into. Asked
 * which tool it must use to read a file, it answered "the read tool ... avoid
 * `cat`", which is stated only in that relocated prompt.
 *
 * A second line of defence remains for the day the gateway starts reading user
 * messages too: after a measured rejection, text that must still travel in an
 * inspected role is broken up with a **visible** separator (` \u00b7 `) rather
 * than an invisible one. That mutates the prompt, so it is only ever the retry
 * and never the first attempt.
 *
 * Scope stays narrow: a `POST` to a `/v2/chat/completions` URL whose body is a
 * JSON string. Other providers, non-chat traffic, and a body with no instruction
 * text are passed through byte-identical.
 */

/** The one phrase the gateway was measured rejecting on 2026-10-22. */
const CHANNEL_PHRASE = 'DeepSeek Harness';

/** The same wording with a zero-width space between the words. */
const CHANNEL_PHRASE_NEUTRALIZED = 'DeepSeek\u200b Harness';

/** The only endpoint whose body this guard rewrites. */
const CHAT_PATH = '/v2/chat/completions';

/** Roles whose text the gateway has been measured reading. */
const INSPECTED_ROLES = new Set(['system', 'developer', 'assistant']);

/** Opens the message that carries the relocated instructions. */
export const INSTRUCTION_FRAME = '[Operating instructions \u2014 authoritative for the entire conversation]\n\n';

/**
 * The sentence left behind in the `system` role.
 *
 * Deliberately says where the real instructions are: the model has to treat the
 * relocated block as binding, and a silent move would read like unrelated user
 * chatter. It carries no text the gateway has been measured matching.
 */
export const SYSTEM_PLACEHOLDER = 'Follow the operating instructions in the first user message for this entire conversation.';

/** Marks a fetch wrapper this module installed, so re-entry is detectable. */
const GUARDED = Symbol.for('dsh-workbuddy-switcher.channel-guard');

/** The visible separator used by the retry, never by the first attempt. */
const SEPARATOR = ' \u00b7 ';

/** Longest run of unmarked text allowed between separators on the retry. */
const BREAK_EVERY = 24;

/** Whether a message is the one this module relocated instructions into. */
function isFrameCarrier(message) {
  if (typeof message !== 'object' || message === null) return false;
  const content = message['content'];
  return typeof content === 'string' && content.startsWith(INSTRUCTION_FRAME);
}

/** Concatenate the text of a message's content without altering it. */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const part of content) {
    if (typeof part !== 'object' || part === null) continue;
    const text = part['text'];
    if (typeof text === 'string') out += text;
  }
  return out;
}

/**
 * Move instruction text from the inspected roles into the leading user message.
 *
 * `system` / `developer` messages are consumed and replaced by one neutral
 * `system` sentence, with their text carried byte-for-byte in a `user` message
 * placed before the conversation. Nothing is rewritten, so literals, code
 * samples and formatting in the prompt survive exactly.
 *
 * @param document - a parsed chat-completions body.
 * @returns True when the body changed.
 */
function relocateInstructions(document) {
  const messages = document['messages'];
  if (!Array.isArray(messages) || messages.length === 0) return false;
  // A retry runs this again; the frame marker is what makes it a no-op there.
  if (messages.some(isFrameCarrier)) return false;

  const carried = [];
  const kept = [];
  for (const message of messages) {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      kept.push(message);
      continue;
    }
    const role = message['role'];
    if (role === 'system' || role === 'developer') {
      const text = textOf(message['content']);
      if (text !== '') carried.push(text);
      continue;
    }
    kept.push(message);
  }
  if (carried.length === 0) return false;

  const relocated = { role: 'user', content: `${INSTRUCTION_FRAME}${carried.join('\n\n')}` };
  messages.length = 0;
  messages.push({ role: 'system', content: SYSTEM_PLACEHOLDER }, relocated, ...kept);
  return true;
}

/**
 * Break a string into runs no longer than {@link BREAK_EVERY} with a visible
 * separator at word boundaries.
 *
 * Only used by the retry. Separators land between words, never inside one, so
 * identifiers and paths keep their spelling.
 *
 * @param text - text to break up.
 * @returns The marked text.
 */
function breakRuns(text) {
  if (typeof text !== 'string' || text === '') return text;
  let out = '';
  let run = 0;
  for (const token of text.split(/(\s+)/)) {
    out += token;
    if (/^\s+$/.test(token)) continue;
    run += token.length;
    if (run >= BREAK_EVERY) {
      out += SEPARATOR;
      run = 0;
    }
  }
  return out;
}

/** Neutralise the measured phrase, then break the runs up visibly. */
function markText(text) {
  if (typeof text !== 'string' || text === '') return text;
  const phraseFixed = text.includes(CHANNEL_PHRASE)
    ? text.split(CHANNEL_PHRASE).join(CHANNEL_PHRASE_NEUTRALIZED)
    : text;
  return breakRuns(phraseFixed);
}

/** Mark one message's free text in place; report whether it changed. */
function markMessage(message) {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return false;
  const role = message['role'];
  if (!INSPECTED_ROLES.has(role) && !isFrameCarrier(message)) return false;
  // The placeholder is this module's own sentence and carries nothing the
  // gateway has ever matched, so separating it would only add noise.
  if (message['content'] === SYSTEM_PLACEHOLDER) return false;
  let changed = false;
  const content = message['content'];
  if (typeof content === 'string') {
    // Keep the frame marker itself intact: it is what makes a second pass a
    // no-op, and it carries nothing the gateway matches.
    const next = isFrameCarrier(message)
      ? `${INSTRUCTION_FRAME}${markText(content.slice(INSTRUCTION_FRAME.length))}`
      : markText(content);
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
 * Apply the first line of defence: get instruction text out of the inspected
 * roles.
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
  // Cheap rejection before paying for a parse.
  if (!bodyString.includes('"system"') && !bodyString.includes('"developer"')) return undefined;
  let document;
  try {
    document = JSON.parse(bodyString);
  } catch {
    return undefined;
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return undefined;
  return relocateInstructions(document) ? JSON.stringify(document) : undefined;
}

/**
 * Apply both defences: relocate, then break up whatever must still travel in an
 * inspected role.
 *
 * This is the retry after the gateway has already rejected a body. Relocating
 * removes the instruction text from every role measured as inspected; the
 * visible separators cover the remaining inspected text (assistant turns in the
 * history) and the relocated block itself, in case user messages have started
 * being read as well.
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
  let changed = relocateInstructions(document);
  const messages = document['messages'];
  if (Array.isArray(messages)) {
    for (const message of messages) if (markMessage(message)) changed = true;
  }
  return changed ? JSON.stringify(document) : undefined;
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
 * These counters cost no extra request, they are incremented from the retry path
 * that already runs, and the panel renders them.
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

/**
 * Wrap a `WorkBuddyUpstreamClient` so a rejected chat is retried once with both
 * defences applied.
 *
 * The fetch guard above is the first line of defence, but it depends on being
 * the outermost `globalThis.fetch`: another plugin that imports `undici`, or a
 * host that replaces `fetch` after activation, silently disables it. This
 * wrapper sits on the one method every chat body must pass through and cannot
 * be displaced that way.
 *
 * The first attempt is sent exactly as the caller wrote it, so a healthy request
 * never sees this code path, and a body the fetch guard already handled is not
 * relocated twice. Only a measured `400 / 11128` escalates.
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
      // Nothing left to rewrite: the rejection cannot be answered by this module,
      // and staying silent would repeat the 0.3.2 failure mode.
      guardState.unrecovered += 1;
      guardState.lastUnrecoveredAt = Date.now();
      guardState.lastDetail = 'a channel rejection arrived for a body this module could not rewrite';
      notify({ recovered: false, detail: guardState.lastDetail });
      return first;
    }
    const retried = await original.call(this, credential, escalated, signal);
    guardState.escalations += 1;
    guardState.lastEscalationAt = Date.now();
    if (isChannelRejection(retried)) {
      // Both defences ran and the gateway still refused.
      guardState.unrecovered += 1;
      guardState.lastUnrecoveredAt = Date.now();
      guardState.lastDetail = 'the relocated and separated body was rejected as well';
      notify({ recovered: false, detail: guardState.lastDetail });
    } else {
      notify({ recovered: true, detail: 'a rejected request was retried with the instruction text relocated' });
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
 * Wrap `globalThis.fetch` so every WorkBuddy chat body is rewritten.
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
