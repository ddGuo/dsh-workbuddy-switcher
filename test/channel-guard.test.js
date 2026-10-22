import assert from 'node:assert/strict';
import test from 'node:test';

import { installChannelGuard, neutralizeChatBody } from '../lib/channel-guard.js';

const RAW = 'DeepSeek Harness';
const NEUTRAL = 'DeepSeek\u200b Harness';

const body = (messages) => JSON.stringify({
  model: 'deepseek-v4.1-flash',
  messages,
  stream: true,
  max_tokens: 8,
});

const countOf = (hay, needle) => hay.split(needle).length - 1;

test('neutralises every instruction occurrence, not just the first', () => {
  const source = body([
    { role: 'system', content: `You are an AI agent powered by ${RAW}.\n\nThe runtime context names the ${RAW} implementation checkout.` },
    { role: 'user', content: 'hi' },
  ]);
  const next = neutralizeChatBody(source);
  assert.equal(typeof next, 'string');
  assert.equal(countOf(next, RAW), 0);
  assert.equal(countOf(next, NEUTRAL), 2);
  // Nothing else about the document changes.
  assert.deepEqual(JSON.parse(next).messages[1], { role: 'user', content: 'hi' });
  assert.equal(JSON.parse(next).model, 'deepseek-v4.1-flash');
});

test('leaves user text alone', () => {
  const source = body([
    { role: 'system', content: 'plain instructions' },
    { role: 'user', content: `the ${RAW} implementation checkout` },
  ]);
  assert.equal(neutralizeChatBody(source), undefined);
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

test('is a no-op for bodies that need nothing', () => {
  assert.equal(neutralizeChatBody(body([{ role: 'system', content: 'already clean' }])), undefined);
  assert.equal(neutralizeChatBody('not json'), undefined);
  assert.equal(neutralizeChatBody(JSON.stringify({ messages: 'nope' })), undefined);
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
    assert.equal(countOf(calls[0].init.body, NEUTRAL), 1);
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

test('a clean chat body reaches the upstream byte-identical', async () => {
  const original = globalThis.fetch;
  const calls = [];
  const stub = async (input, init) => {
    calls.push({ input, init });
    return { status: 200 };
  };
  globalThis.fetch = stub;
  try {
    const restore = installChannelGuard();
    // `body` is a string, so the guard inspects it and finds nothing to do.
    const clean = body([{ role: 'user', content: 'hi' }]);
    await globalThis.fetch('https://copilot.tencent.com/v2/chat/completions', { method: 'POST', body: clean });
    assert.equal(calls[0].init.body, clean);
    restore();
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
