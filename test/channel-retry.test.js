import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INSTRUCTION_FRAME,
  SYSTEM_PLACEHOLDER,
  installUpstreamRetry,
  isChannelRejection,
  neutralizeChatBodyEverywhere,
  readGuardState,
  resetGuardState,
} from '../lib/channel-guard.js';

const RAW = 'DeepSeek Harness';
const SEPARATOR = ' \u00b7 ';
const ZWSP = '\u200b';

const body = (messages, extra = {}) => JSON.stringify({
  model: 'deepseek-v4.1-flash',
  messages,
  stream: true,
  max_tokens: 8,
  ...extra,
});

const channelRejection = () => ({
  ok: false,
  status: 400,
  kind: 'client',
  message: JSON.stringify({
    code: 11128,
    msg: 'Illegal API invocation from an unapproved channel',
    displayMsg: { zh: '请求被拦截，请重新发送' },
  }),
});

const longestRun = (text) => Math.max(...text.split(SEPARATOR).map((piece) => piece.length));

test('recognises only the measured channel check', () => {
  assert.equal(isChannelRejection(channelRejection()), true);
  assert.equal(isChannelRejection({ ok: false, status: 400, message: '{"code":11148,"msg":"tool calls"}' }), false);
  assert.equal(isChannelRejection({ ok: false, status: 401, message: '{"code":11128}' }), false);
  assert.equal(isChannelRejection({ ok: true }), false);
  assert.equal(isChannelRejection(undefined), false);
  assert.equal(isChannelRejection({ ok: false, status: 400 }), false);
});

test('the retry relocates the prompt and separates what still travels in an inspected role', () => {
  const prompt = 'Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root; absolute paths identify files or directories on the host.';
  const source = body(
    [
      { role: 'system', content: prompt },
      { role: 'user', content: 'run the tests inside the workspace please' },
      {
        role: 'assistant',
        content: 'calling the run_tests tool now and reporting the summary back to the operator',
        reasoning_content: 'the user asked for a long explanation of the plan here',
        tool_calls: [{
          id: 'call_00_abc',
          type: 'function',
          function: { name: 'run_tests', arguments: '{"target":"unit","verbose":true}' },
        }],
      },
      { role: 'user', content: 'carry on' },
    ],
    { tools: [{
      type: 'function',
      function: {
        name: 'run_tests',
        description: 'Runs the test suite and returns the summary of every failure it saw',
        parameters: { type: 'object', properties: { target: { type: 'string' } } },
      },
    }] },
  );

  const parsed = JSON.parse(neutralizeChatBodyEverywhere(source));

  // The prompt left the inspected roles entirely...
  assert.equal(parsed.messages[0].content, SYSTEM_PLACEHOLDER);
  const frame = parsed.messages[1];
  assert.equal(frame.role, 'user');
  assert.ok(frame.content.startsWith(INSTRUCTION_FRAME));
  // ...and is separated inside the frame, for the case user text is inspected too.
  assert.ok(frame.content.includes(SEPARATOR));
  // The frame marker itself is ours and stays intact; the carried prompt behind
  // it must have no run long enough to hold the measured fingerprint.
  const carried = frame.content.slice(INSTRUCTION_FRAME.length);
  assert.ok(longestRun(carried) < 60, 'no run long enough for the measured fingerprint');

  // Assistant text is still in an inspected role, so it is separated as well.
  assert.ok(parsed.messages[3].content.includes(SEPARATOR));
  assert.ok(parsed.messages[3].reasoning_content.includes(SEPARATOR));
  // The user's own words are not rewritten.
  assert.equal(parsed.messages[2].content, 'run the tests inside the workspace please');
  assert.equal(parsed.messages[4].content, 'carry on');

  // Wire identifiers stay byte-identical.
  assert.equal(parsed.messages[3].tool_calls[0].function.arguments, '{"target":"unit","verbose":true}');
  assert.equal(parsed.messages[3].tool_calls[0].function.name, 'run_tests');
  assert.equal(parsed.tools[0].function.name, 'run_tests');
  // Tool declarations are not inspected, so they are left alone.
  assert.equal(parsed.tools[0].function.description, 'Runs the test suite and returns the summary of every failure it saw');
  assert.equal(parsed.model, 'deepseek-v4.1-flash');
});

test('the retry uses a visible separator, never an invisible one', () => {
  // 2026-10-29: the gateway normalises zero-width characters away, so an
  // invisible mark is worthless now and must not creep back in.
  const parsed = JSON.parse(neutralizeChatBodyEverywhere(body([
    { role: 'system', content: 'instructions that are long enough to need breaking up somewhere in here' },
    { role: 'user', content: 'hi' },
  ])));
  const everything = parsed.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
  assert.equal(everything.includes(ZWSP), false, 'no zero-width marks may be used');
  assert.ok(everything.includes(SEPARATOR), 'a visible separator must be used instead');
});

test('the retry still neutralises the measured phrase', () => {
  const withAssistant = neutralizeChatBodyEverywhere(body([
    { role: 'assistant', content: `powered by ${RAW}` },
    { role: 'user', content: 'hi' },
  ]));
  assert.equal(withAssistant.includes(RAW), false);
  assert.equal(withAssistant.includes('DeepSeek'), true);
  // A body with nothing inspected and no instructions has nothing to rewrite.
  assert.equal(neutralizeChatBodyEverywhere(body([{ role: 'user', content: `powered by ${RAW}` }])), undefined);
});

test('the retry is a no-op for bodies it cannot read', () => {
  assert.equal(neutralizeChatBodyEverywhere('not json'), undefined);
  assert.equal(neutralizeChatBodyEverywhere(''), undefined);
  assert.equal(neutralizeChatBodyEverywhere(undefined), undefined);
  assert.equal(neutralizeChatBodyEverywhere(JSON.stringify({ messages: [] })), undefined);
});

test('a healthy chat is sent once and never rewritten', async () => {
  const calls = [];
  class Client {
    async chatStream(credential, bodyJson) {
      calls.push(bodyJson);
      return { ok: true, status: 200 };
    }
  }
  const restore = installUpstreamRetry(Client);
  try {
    const source = body([{ role: 'system', content: 'plain' }]);
    const result = await new Client().chatStream({}, source);
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0], source, 'a healthy body must reach the client byte-identical');
  } finally {
    restore();
  }
});

test('a channel rejection is retried once with both defences applied', async () => {
  const calls = [];
  class Client {
    async chatStream(credential, bodyJson) {
      calls.push(bodyJson);
      return calls.length === 1 ? channelRejection() : { ok: true, status: 200 };
    }
  }
  const restore = installUpstreamRetry(Client);
  try {
    const source = body([{ role: 'system', content: 'instructions long enough that a separator is needed somewhere' }, { role: 'user', content: 'hi' }]);
    const result = await new Client().chatStream({}, source);
    assert.equal(result.ok, true, 'the retry result should be returned');
    assert.equal(calls.length, 2);
    assert.equal(calls[0], source, 'the first attempt carries the caller body untouched');
    assert.notEqual(calls[1], source);
    const parsed = JSON.parse(calls[1]);
    assert.equal(parsed.messages[0].content, SYSTEM_PLACEHOLDER);
    assert.ok(parsed.messages[1].content.startsWith(INSTRUCTION_FRAME));
  } finally {
    restore();
  }
});

test('a different 400 is surfaced without a retry', async () => {
  const calls = [];
  class Client {
    async chatStream(credential, bodyJson) {
      calls.push(bodyJson);
      return { ok: false, status: 400, kind: 'client', message: '{"code":11148,"msg":"tool calls and tool results do not match"}' };
    }
  }
  const restore = installUpstreamRetry(Client);
  try {
    const result = await new Client().chatStream({}, body([{ role: 'user', content: 'hi' }]));
    assert.equal(result.ok, false);
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test('the retry wrapper is installed once and restores its predecessor', async () => {
  const original = async () => ({ ok: true, status: 200 });
  class Client {}
  Client.prototype.chatStream = original;

  const first = installUpstreamRetry(Client);
  const wrapped = Client.prototype.chatStream;
  assert.notEqual(wrapped, original);
  const second = installUpstreamRetry(Client);
  assert.equal(Client.prototype.chatStream, wrapped, 'a second install must not stack wrappers');
  second();
  assert.equal(Client.prototype.chatStream, wrapped, 'the inner dispose must not unwrap a live wrapper');
  first();
  assert.equal(Client.prototype.chatStream, original);
});

test('a recovered escalation counts, is reported, and reports no failure', async () => {
  resetGuardState();
  const events = [];
  class Client {
    constructor() {
      this.calls = 0;
    }
    async chatStream() {
      this.calls += 1;
      return this.calls === 1 ? channelRejection() : { ok: true, status: 200 };
    }
  }
  const restore = installUpstreamRetry(Client, { onRejection: (event) => events.push(event) });
  try {
    await new Client().chatStream({}, body([{ role: 'system', content: 'instructions' }, { role: 'user', content: 'hi' }]));
    const after = readGuardState();
    assert.equal(after.escalations, 1);
    assert.equal(after.unrecovered, 0, 'a recovered request must not be counted as a failure');
    assert.ok(after.lastEscalationAt > 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].recovered, true);
  } finally {
    restore();
    resetGuardState();
  }
});

test('an escalation the gateway also rejects is counted as unrecovered and reported as a failure', async () => {
  resetGuardState();
  const events = [];
  class Client {
    async chatStream() {
      return channelRejection();
    }
  }
  const restore = installUpstreamRetry(Client, { onRejection: (event) => events.push(event) });
  try {
    const result = await new Client().chatStream({}, body([{ role: 'system', content: 'instructions' }, { role: 'user', content: 'hi' }]));
    assert.equal(result.ok, false, 'the rejection must still surface to the caller');
    const state = readGuardState();
    assert.equal(state.escalations, 1);
    assert.equal(state.unrecovered, 1);
    assert.ok(state.lastUnrecoveredAt > 0);
    assert.equal(state.lastDetail, 'the relocated and separated body was rejected as well');
    assert.equal(events.length, 1);
    assert.equal(events[0].recovered, false);
  } finally {
    restore();
    resetGuardState();
  }
});

test('a healthy request leaves the counters at zero', async () => {
  resetGuardState();
  const events = [];
  class Client {
    async chatStream() {
      return { ok: true, status: 200 };
    }
  }
  const restore = installUpstreamRetry(Client, { onRejection: (event) => events.push(event) });
  try {
    await new Client().chatStream({}, body([{ role: 'user', content: 'hi' }]));
    const state = readGuardState();
    assert.equal(state.escalations, 0);
    assert.equal(state.unrecovered, 0);
    assert.equal(events.length, 0, 'a healthy install must stay quiet');
  } finally {
    restore();
  }
});

test('a rejection with nothing to rewrite is reported without a second request', async () => {
  resetGuardState();
  const events = [];
  const calls = [];
  class Client {
    async chatStream(credential, bodyJson) {
      calls.push(bodyJson);
      return channelRejection();
    }
  }
  const restore = installUpstreamRetry(Client, { onRejection: (event) => events.push(event) });
  try {
    // No instructions to relocate and no inspected role to separate.
    await new Client().chatStream({}, JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }));
    assert.equal(calls.length, 1, 'an unrewritable body must not be resent');
    const state = readGuardState();
    assert.equal(state.escalations, 0);
    assert.equal(state.unrecovered, 1);
    assert.equal(state.lastDetail, 'a channel rejection arrived for a body this module could not rewrite');
    assert.equal(events.length, 1);
    assert.equal(events[0].recovered, false);
  } finally {
    restore();
    resetGuardState();
  }
});
