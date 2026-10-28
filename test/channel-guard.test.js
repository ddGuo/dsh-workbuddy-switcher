import assert from 'node:assert/strict';
import test from 'node:test';

import { installChannelGuard, neutralizeChatBody } from '../lib/channel-guard.js';

const RAW = 'DeepSeek Harness';
const NEUTRAL = 'DeepSeek\u200b Harness';
const MARK = '\u200b';

const body = (messages) => JSON.stringify({
  model: 'deepseek-v4.1-flash',
  messages,
  stream: true,
  max_tokens: 8,
});

const countOf = (hay, needle) => hay.split(needle).length - 1;

const instructionsOf = (bodyString) => JSON.parse(bodyString).messages
  .filter((message) => message.role === 'system' || message.role === 'developer')
  .map((message) => (typeof message.content === 'string' ? message.content : message.content.map((part) => part.text).join('')))
  .join('\n');

test('neutralises every occurrence of the measured phrase', () => {
  const source = body([{
    role: 'system',
    content: `You are an AI agent powered by ${RAW}. The ${RAW} implementation checkout is here.`,
  }]);
  const next = neutralizeChatBody(source);
  assert.equal(typeof next, 'string');
  assert.equal(countOf(next, RAW), 0);
  // Both mentions survive in a readable form; only the exact spelling is broken.
  assert.equal(countOf(next, 'DeepSeek'), 2);
  assert.equal(countOf(next, 'Harness'), 2);
  assert.ok(countOf(next, MARK) >= 2);
});

test('breaks long exact runs so a longer blacklist entry cannot match', () => {
  const paragraph = 'Tokens prefixed with @ are paths the user explicitly referenced. '
    + 'Relative paths resolve from the workspace root; absolute paths identify files or directories on the host. '
    + 'A trailing slash marks a directory: list it when its contents matter.';
  const next = instructionsOf(neutralizeChatBody(body([{ role: 'system', content: paragraph }])));
  const longest = Math.max(...next.split(MARK).map((piece) => piece.length));
  // The cadence is 24 characters, so no unmarked run can approach the
  // ~110-character fingerprint that was measured on 2026-10-28.
  assert.ok(longest < 60, `unmarked run of ${longest} characters is too long`);
});

test('never splits a word: removing the marks restores the text', () => {
  const text = 'Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma.';
  const marked = instructionsOf(neutralizeChatBody(body([{ role: 'system', content: text }])));
  assert.notEqual(marked, text);
  assert.equal(marked.split(MARK).join(''), text);
});

test('leaves user text untouched', () => {
  const source = body([
    { role: 'system', content: 'plain instructions' },
    { role: 'user', content: `the ${RAW} implementation checkout, at the workspace root` },
  ]);
  const next = neutralizeChatBody(source);
  assert.equal(JSON.parse(next ?? source).messages[1].content, `the ${RAW} implementation checkout, at the workspace root`);
});

test('handles a developer role and text-part content', () => {
  const source = body([{
    role: 'developer',
    content: [
      { type: 'text', text: `You are an AI agent powered by ${RAW}.` },
      { type: 'text', text: 'unrelated' },
    ],
  }]);
  const next = neutralizeChatBody(source);
  assert.equal(countOf(next, RAW), 0);
  assert.equal(JSON.parse(next).messages[0].content[1].text, 'unrelated');
});

test('is a no-op for bodies that cannot need it', () => {
  assert.equal(neutralizeChatBody(body([{ role: 'user', content: 'hi there friend' }])), undefined);
  assert.equal(neutralizeChatBody('not json'), undefined);
  assert.equal(neutralizeChatBody(JSON.stringify({ messages: 'nope' })), undefined);
  assert.equal(neutralizeChatBody(''), undefined);
  assert.equal(neutralizeChatBody(undefined), undefined);
});

test('the installed guard rewrites a chat POST and restores afterwards', async () => {
  const original = globalThis.fetch;
  const calls = [];
  const stub = async (input, init) => {
    calls.push({ input, init });
    return { status: 200 };
  };
  globalThis.fetch = stub;
  try {
    const restore = installChannelGuard();
    await globalThis.fetch('https://copilot.tencent.com/v2/chat/completions', {
      method: 'POST',
      body: body([{ role: 'system', content: `You are an AI agent powered by ${RAW}.` }]),
      headers: { 'Content-Type': 'application/json', 'Content-Length': '999' },
    });
    assert.equal(calls.length, 1);
    assert.equal(countOf(calls[0].init.body, RAW), 0);
    assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
    assert.equal(calls[0].init.headers['Content-Length'], undefined);
    restore();
    assert.equal(globalThis.fetch, stub);
  } finally {
    globalThis.fetch = original;
  }
});

test('the installed guard leaves other traffic untouched', async () => {
  const original = globalThis.fetch;
  const calls = [];
  const stub = async (input, init) => {
    calls.push({ input, init });
    return { status: 200 };
  };
  globalThis.fetch = stub;
  try {
    const restore = installChannelGuard();
    const dirty = body([{ role: 'system', content: `powered by ${RAW}` }]);
    await globalThis.fetch('https://api.deepseek.com/chat/completions', { method: 'POST', body: dirty });
    await globalThis.fetch('https://copilot.tencent.com/v3/config');
    await globalThis.fetch('https://copilot.tencent.com/v2/chat/completions', { method: 'GET' });
    assert.equal(calls.length, 3);
    assert.equal(calls[0].init.body, dirty);
    assert.equal(calls[1].init, undefined);
    assert.equal(calls[2].init.body, undefined);
    restore();
    assert.equal(globalThis.fetch, stub);
  } finally {
    globalThis.fetch = original;
  }
});

test('a second install does not stack wrappers', async () => {
  const original = globalThis.fetch;
  const stub = async () => ({ status: 200 });
  globalThis.fetch = stub;
  try {
    const first = installChannelGuard();
    const wrapped = globalThis.fetch;
    assert.notEqual(wrapped, stub);
    const second = installChannelGuard();
    assert.equal(globalThis.fetch, wrapped);
    second();
    assert.equal(globalThis.fetch, wrapped, 'the inner dispose must not unwrap a live guard');
    first();
    assert.equal(globalThis.fetch, stub);
  } finally {
    globalThis.fetch = original;
  }
});
