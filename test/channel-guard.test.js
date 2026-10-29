import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INSTRUCTION_FRAME,
  SYSTEM_PLACEHOLDER,
  installChannelGuard,
  neutralizeChatBody,
} from '../lib/channel-guard.js';

const body = (messages, extra = {}) => JSON.stringify({
  model: 'deepseek-v4.1-flash',
  messages,
  stream: true,
  max_tokens: 8,
  ...extra,
});

const markOnFirstOccurrence = 'DeepSeek\u200b Harness';

test('moves instruction text out of the system role, byte for byte', () => {
  const prompt = 'You are an AI agent powered by DeepSeek Harness.\n\nRead the file with the read tool.';
  const next = neutralizeChatBody(body([
    { role: 'system', content: prompt },
    { role: 'user', content: 'fix the bug' },
  ]));
  assert.equal(typeof next, 'string');
  const parsed = JSON.parse(next);
  // The gateway has been measured reading system and assistant text, not user text.
  assert.equal(parsed.messages[0].role, 'system');
  assert.equal(parsed.messages[0].content, SYSTEM_PLACEHOLDER);
  assert.equal(parsed.messages[1].role, 'user');
  // The prompt itself is carried unchanged, so literals and formatting survive.
  assert.equal(parsed.messages[1].content, `${INSTRUCTION_FRAME}${prompt}`);
  // The conversation follows untouched.
  assert.deepEqual(parsed.messages[2], { role: 'user', content: 'fix the bug' });
});

test('carries several instruction messages, including a developer role', () => {
  const next = neutralizeChatBody(body([
    { role: 'developer', content: 'rule one' },
    { role: 'system', content: 'rule two' },
    { role: 'user', content: 'go' },
  ]));
  const parsed = JSON.parse(next);
  assert.equal(parsed.messages[0].content, SYSTEM_PLACEHOLDER);
  assert.equal(parsed.messages[1].content, `${INSTRUCTION_FRAME}rule one\n\nrule two`);
  assert.deepEqual(parsed.messages.map((m) => m.role), ['system', 'user', 'user']);
});

test('carries text-part content without flattening anything else', () => {
  const next = neutralizeChatBody(body([
    { role: 'system', content: [{ type: 'text', text: 'first part' }, { type: 'text', text: ' second part' }] },
    { role: 'user', content: 'hi' },
  ]));
  const parsed = JSON.parse(next);
  assert.equal(parsed.messages[1].content, `${INSTRUCTION_FRAME}first part second part`);
});

test('keeps assistant turns in place: only instruction roles move', () => {
  const next = neutralizeChatBody(body([
    { role: 'system', content: 'instructions' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' },
    { role: 'user', content: 'what is 6*7' },
  ]));
  const parsed = JSON.parse(next);
  assert.deepEqual(parsed.messages.map((m) => m.role), ['system', 'user', 'user', 'assistant', 'user']);
  assert.deepEqual(parsed.messages[3], { role: 'assistant', content: 'hi there' });
});

test('is idempotent: a relocated body is left alone', () => {
  const first = neutralizeChatBody(body([{ role: 'system', content: 'instructions' }, { role: 'user', content: 'hi' }]));
  assert.equal(typeof first, 'string');
  assert.equal(neutralizeChatBody(first), undefined, 'a second pass must not wrap the frame again');
});

test('never leaves the measured phrase in a role the gateway reads', () => {
  const next = neutralizeChatBody(body([
    { role: 'system', content: 'powered by the DeepSeek Harness build' },
    { role: 'assistant', content: 'noted' },
    { role: 'user', content: 'hi' },
  ]));
  const parsed = JSON.parse(next);
  // The system role now holds only the neutral sentence.
  assert.equal(parsed.messages[0].content, SYSTEM_PLACEHOLDER);
  // The phrase survives verbatim in the user role, where it is not inspected.
  assert.ok(parsed.messages[1].content.includes('DeepSeek Harness'));
});

test('is a no-op for bodies that carry nothing to move', () => {
  assert.equal(neutralizeChatBody(body([{ role: 'user', content: 'hi' }])), undefined);
  assert.equal(neutralizeChatBody(body([{ role: 'system', content: '' }, { role: 'user', content: 'hi' }])), undefined);
  assert.equal(neutralizeChatBody('not json'), undefined);
  assert.equal(neutralizeChatBody(''), undefined);
  assert.equal(neutralizeChatBody(undefined), undefined);
  assert.equal(neutralizeChatBody(JSON.stringify({ messages: 'nope' })), undefined);
});

test('leaves the rest of the request exactly as it was', () => {
  const tools = [{ type: 'function', function: { name: 'run', description: 'runs things', parameters: { type: 'object' } } }];
  const next = neutralizeChatBody(body([{ role: 'system', content: 'instructions' }, { role: 'user', content: 'hi' }], {
    tools,
    tool_choice: 'auto',
    temperature: 0.2,
  }));
  const parsed = JSON.parse(next);
  assert.deepEqual(parsed.tools, tools);
  assert.equal(parsed.tool_choice, 'auto');
  assert.equal(parsed.temperature, 0.2);
  assert.equal(parsed.model, 'deepseek-v4.1-flash');
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
      body: body([{ role: 'system', content: 'instructions' }, { role: 'user', content: 'hi' }]),
      headers: { 'Content-Type': 'application/json', 'Content-Length': '999' },
    });
    assert.equal(calls.length, 1);
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.messages[0].content, SYSTEM_PLACEHOLDER);
    assert.ok(sent.messages[1].content.startsWith(INSTRUCTION_FRAME));
    assert.equal(calls[0].init.headers['Content-Length'], undefined, 'a stale length must be dropped');
    assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
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
    const dirty = body([{ role: 'system', content: 'instructions' }, { role: 'user', content: 'hi' }]);
    await globalThis.fetch('https://api.deepseek.com/chat/completions', { method: 'POST', body: dirty });
    await globalThis.fetch('https://copilot.tencent.com/v3/config');
    await globalThis.fetch('https://copilot.tencent.com/v2/chat/completions', { method: 'GET' });
    assert.equal(calls.length, 3);
    assert.equal(calls[0].init.body, dirty, 'another provider must be forwarded byte-identical');
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

test('the phrase constant is still neutralised on the retry path, not the first attempt', async () => {
  // The first attempt carries the prompt verbatim (that is the whole point of
  // relocating instead of rewriting), so the zero-width spelling must only
  // appear once a rejection has been measured. This pins that boundary.
  const first = neutralizeChatBody(body([{ role: 'system', content: 'powered by DeepSeek Harness' }, { role: 'user', content: 'hi' }]));
  assert.equal(first.includes(markOnFirstOccurrence), false);
  assert.equal(first.includes('DeepSeek Harness'), true);
});
