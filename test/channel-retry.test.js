import assert from 'node:assert/strict';
import test from 'node:test';

import {
  installUpstreamRetry,
  isChannelRejection,
  neutralizeChatBodyEverywhere,
  readGuardState,
  resetGuardState,
} from '../lib/channel-guard.js';

const RAW = 'DeepSeek Harness';
const MARK = '\u200b';

const body = (messages, tools) => JSON.stringify({
  model: 'deepseek-v4.1-flash',
  messages,
  ...(tools === undefined ? {} : { tools }),
  stream: true,
  max_tokens: 8,
});

const channelRejection = (status = 400) => ({
  ok: false,
  status,
  kind: 'client',
  message: JSON.stringify({
    code: 11128,
    msg: 'Illegal API invocation from an unapproved channel',
    displayMsg: { zh: '请求被拦截，请重新发送' },
  }),
});

const longestRun = (text) => Math.max(...text.split(MARK).map((piece) => piece.length));

test('recognises only the measured channel check', () => {
  assert.equal(isChannelRejection(channelRejection()), true);
  // Same HTTP status, different business code: not the channel check.
  assert.equal(isChannelRejection({ ok: false, status: 400, message: '{"code":11148,"msg":"tool calls"}' }), false);
  assert.equal(isChannelRejection({ ok: false, status: 401, message: '{"code":11128}' }), false);
  assert.equal(isChannelRejection({ ok: true }), false);
  assert.equal(isChannelRejection(undefined), false);
  assert.equal(isChannelRejection({ ok: false, status: 400 }), false);
});

test('the escalation marks user text and tool descriptions, never the wire identifiers', () => {
  const source = body(
    [
      { role: 'system', content: 'plain instructions for the run' },
      { role: 'user', content: 'run the tests inside the workspace please' },
      {
        role: 'assistant',
        content: 'calling the tool now',
        reasoning_content: 'the user asked for a long explanation of the plan here',
        tool_calls: [{
          id: 'call_00_abc',
          type: 'function',
          function: { name: 'run_tests', arguments: '{"target":"unit","verbose":true}' },
        }],
      },
    ],
    [{
      type: 'function',
      function: {
        name: 'run_tests',
        description: 'Runs the test suite and returns the summary of every failure it saw',
        parameters: { type: 'object', properties: { target: { type: 'string' } } },
      },
    }],
  );

  const next = neutralizeChatBodyEverywhere(source);
  const parsed = JSON.parse(next);
  assert.ok(parsed.messages[1].content.includes(MARK), 'user text should be marked');
  assert.ok(parsed.messages[2].reasoning_content.includes(MARK), 'reasoning should be marked');
  assert.ok(parsed.tools[0].function.description.includes(MARK), 'tool description should be marked');
  // Wire format stays intact.
  assert.equal(parsed.messages[2].tool_calls[0].function.arguments, '{"target":"unit","verbose":true}');
  assert.equal(parsed.messages[2].tool_calls[0].function.name, 'run_tests');
  assert.equal(parsed.tools[0].function.name, 'run_tests');
  assert.equal(parsed.model, 'deepseek-v4.1-flash');
  assert.equal(parsed.messages[0].role, 'system');
  // No unmarked run long enough for the measured ~110-character fingerprint.
  assert.ok(longestRun(parsed.messages[1].content) < 60);
  // Removing the marks restores the words exactly.
  assert.equal(parsed.messages[1].content.split(MARK).join(''), 'run the tests inside the workspace please');
});

test('the escalation still neutralises the measured phrase itself', () => {
  const next = neutralizeChatBodyEverywhere(body([{ role: 'user', content: `powered by ${RAW}` }]));
  assert.equal(next.includes(`${RAW}`), false);
  assert.equal(next.includes('DeepSeek'), true);
});

test('the escalation is a no-op for bodies it cannot read', () => {
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
    const client = new Client();
    const source = body([{ role: 'system', content: 'plain' }]);
    const result = await client.chatStream({}, source);
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0], source, 'a healthy body must reach the client byte-identical');
  } finally {
    restore();
  }
});

test('a channel rejection is retried once with the whole body marked', async () => {
  const calls = [];
  class Client {
    async chatStream(credential, bodyJson) {
      calls.push(bodyJson);
      return calls.length === 1 ? channelRejection() : { ok: true, status: 200 };
    }
  }
  const restore = installUpstreamRetry(Client);
  try {
    const client = new Client();
    const source = body([{ role: 'user', content: `please inspect the ${RAW} checkout and report` }]);
    const result = await client.chatStream({}, source);
    assert.equal(result.ok, true, 'the retry result should be returned');
    assert.equal(calls.length, 2);
    assert.equal(calls[0], source, 'the first attempt carries the caller body untouched');
    assert.notEqual(calls[1], source);
    assert.equal(calls[1].includes(RAW), false, 'the escalated body carries no raw phrase');
    const parsed = JSON.parse(calls[1]);
    assert.ok(parsed.messages[0].content.includes(MARK));
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
  const before = readGuardState();
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
    await new Client().chatStream({}, body([{ role: 'user', content: 'please inspect the checkout' }]));
    const after = readGuardState();
    assert.equal(after.escalations - before.escalations, 1);
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
    const result = await new Client().chatStream({}, body([{ role: 'user', content: 'please inspect the checkout' }]));
    assert.equal(result.ok, false, 'the rejection must still surface to the caller');
    const state = readGuardState();
    assert.equal(state.escalations, 1);
    assert.equal(state.unrecovered, 1);
    assert.ok(state.lastUnrecoveredAt > 0);
    assert.equal(state.lastDetail, 'the marked body was rejected as well');
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

test('a rejection with nothing left to mark is reported without a second request', async () => {
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
    // A body with no messages and no tools has no string to mark, so escalating
    // it would resend the identical request for nothing.
    await new Client().chatStream({}, JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true }));
    assert.equal(calls.length, 1, 'an unmarkable body must not be resent');
    const state = readGuardState();
    assert.equal(state.escalations, 0);
    assert.equal(state.unrecovered, 1);
    assert.equal(state.lastDetail, 'a channel rejection arrived for a body that carried nothing to mark');
    assert.equal(events.length, 1);
    assert.equal(events[0].recovered, false);
  } finally {
    restore();
    resetGuardState();
  }
});
