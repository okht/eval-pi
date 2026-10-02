import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createPiModel } from '../examples/openai-customer-service/pi-model.mjs';

const model = { id: 'test-model', provider: 'test-provider', api: 'openai-responses' };
const usage = { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, reasoning: 1, totalTokens: 20, cost: { total: 0 } };
const reply = (content = [{ type: 'text', text: '已查询。' }], extra = {}) => ({ role: 'assistant', ...model, model: model.id, content, usage, stopReason: 'stop', timestamp: 100, ...extra });
const request = (input = '查询订单', extra = {}) => ({ input, modelSettings: {}, tools: [], handoffs: [], outputType: 'text', tracing: false, ...extra });
const schema = { type: 'object', properties: {}, required: [], additionalProperties: false };

test('maps normal functions and SDK handoffs to Pi tools and fixes resource options', async () => {
  let observed;
  const calls = [];
  const adapter = createPiModel({ model, sessionId: 'attempt-1', onCall: (value) => calls.push(value), runtime: { async completeSimple(...args) { observed = args; return reply(); } } });
  const result = await adapter.getResponse(request('查订单', {
    systemInstructions: '只根据工具回答',
    tools: [{ type: 'function', name: 'lookup', description: 'Read order', parameters: schema, strict: true }],
    handoffs: [{ toolName: 'transfer_to_faq', toolDescription: 'Transfer to FAQ', inputJsonSchema: schema, strictJsonSchema: true }],
  }));
  assert.deepEqual(observed[1].tools.map((tool) => tool.name), ['lookup', 'transfer_to_faq']);
  assert.deepEqual(observed[1].tools[1].parameters, schema);
  assert.equal(observed[1].systemPrompt, '只根据工具回答');
  assert.equal(observed[2].maxRetries, 0);
  assert.equal(observed[2].cacheRetention, 'none');
  assert.equal(observed[2].reasoning, 'low');
  assert.equal(observed[2].maxTokens, 1800);
  assert.equal(observed[2].timeoutMs, 60_000);
  assert.equal(observed[2].sessionId, 'attempt-1');
  assert.equal(result.usage.inputTokens, 15);
  assert.equal(result.usage.totalTokens, 20);
  assert.equal(calls[0].reply, '已查询。');
  assert.equal(calls[0].status, 'completed');
  assert.equal(calls[0].model, model.id);
});

test('round trips reasoning signatures, tool call IDs, and SDK result text inside one attempt', async () => {
  const seen = [];
  const first = reply([
    { type: 'thinking', thinking: 'private reasoning', thinkingSignature: 'opaque signature' },
    { type: 'toolCall', id: 'call_1|fc_1', name: 'lookup', arguments: { order: 'A1' }, thoughtSignature: 'tool signature' },
  ], { stopReason: 'toolUse' });
  const adapter = createPiModel({ model, sessionId: 'attempt-1', runtime: { async completeSimple(_, context) { seen.push(context); return seen.length === 1 ? first : reply(); } } });
  const initial = await adapter.getResponse(request());
  assert.deepEqual(initial.output[0].content, []);
  assert.equal(JSON.stringify(initial).includes('private reasoning'), false);
  assert.equal(JSON.stringify(initial).includes('opaque signature'), false);
  const call = initial.output[1];
  assert.equal(call.callId, 'call_1|fc_1');
  assert.equal(call.arguments, '{"order":"A1"}');
  await adapter.getResponse(request([
    { role: 'user', content: [{ type: 'input_text', text: '查询订单' }] },
    ...structuredClone(initial.output),
    { type: 'function_call_result', name: 'lookup', callId: call.callId, output: [{ type: 'input_text', text: '{"status":"shipped"}' }], status: 'completed' },
  ]));
  assert.deepEqual(seen[1].messages[1].content, first.content);
  assert.equal(seen[1].messages[2].toolCallId, call.callId);
  assert.equal(seen[1].messages[2].content[0].text, '{"status":"shipped"}');
  assert.equal(seen[1].messages[2].isError, false);
});

test('accepts unowned SDK text and function-call history without changing call arguments', async () => {
  let observed;
  const adapter = createPiModel({ model, sessionId: 'attempt-1', runtime: { async completeSimple(_, context) { observed = context; return reply(); } } });
  await adapter.getResponse(request([
    { role: 'system', content: '规则' }, { role: 'user', content: '开始' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '正在查' }], status: 'completed' },
    { type: 'function_call', name: 'lookup', callId: 'original-id', arguments: '{"a":1}' },
    { type: 'function_call_result', name: 'lookup', callId: 'original-id', output: { type: 'text', text: 'timeout' }, status: 'incomplete' },
  ]));
  assert.equal(observed.messages[0].role, 'system');
  assert.equal(observed.messages[2].content[1].id, 'original-id');
  assert.deepEqual(observed.messages[2].content[1].arguments, { a: 1 });
  assert.equal(observed.messages[3].isError, true);
});

test('new factories isolate context and reject another attempt opaque history', async () => {
  const seen = [];
  const runtime = { async completeSimple(_, context, options) { seen.push({ context, options }); return reply(); } };
  const a = createPiModel({ runtime, model, sessionId: 'attempt-A' });
  const b = createPiModel({ runtime, model, sessionId: 'attempt-B' });
  const answer = await a.getResponse(request('A secret'));
  await b.getResponse(request('B only'));
  assert.equal(JSON.stringify(seen[1].context).includes('A secret'), false);
  assert.equal(seen[1].options.sessionId, 'attempt-B');
  await assert.rejects(b.getResponse(request(answer.output)), { code: 'ADAPTER_HISTORY' });
  assert.equal(seen.length, 2);
});

test('unknown modalities, tools, and altered cached history are rejected before calling runtime', async () => {
  let calls = 0;
  const adapter = createPiModel({ model, sessionId: 'attempt-1', runtime: { async completeSimple() { calls++; return reply(); } } });
  for (const invalid of [
    request([{ type: 'computer_call', callId: 'x' }]),
    request([{ role: 'user', content: [{ type: 'input_image', image: 'x' }] }]),
    request('x', { tools: [{ type: 'hosted_tool', name: 'web' }] }),
    request('x', { outputType: { type: 'json_schema' } }),
    request('x', { modelSettings: { toolChoice: 'required' } }),
  ]) await assert.rejects(adapter.getResponse(invalid), { code: 'ADAPTER_UNSUPPORTED' });
  assert.equal(calls, 0);
  const result = await adapter.getResponse(request());
  result.output[0].content[0].text = 'tampered';
  await assert.rejects(adapter.getResponse(request(result.output)), { code: 'ADAPTER_HISTORY' });
  assert.equal(calls, 1);
});

test('cancellation returns immediately even when provider ignores AbortSignal', async () => {
  const controller = new AbortController();
  let providerSignal;
  let lateResolve;
  const adapter = createPiModel({ model, sessionId: 'attempt-1', runtime: { completeSimple(_, __, options) { providerSignal = options.signal; return new Promise((resolve) => { lateResolve = resolve; }); } } });
  const pending = adapter.getResponse(request('x', { signal: controller.signal }));
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { code: 'MODEL_CANCELLED' });
  assert.equal(providerSignal.aborted, true);
  lateResolve(reply());
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(adapter.getResponse(request('x', { signal: controller.signal })), { code: 'MODEL_CANCELLED' });
});

test('enforces local 60 second deadline even when provider never settles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let providerSignal;
  const adapter = createPiModel({ model, sessionId: 'attempt-1', runtime: { completeSimple(_, __, options) { providerSignal = options.signal; return new Promise(() => {}); } } });
  const pending = adapter.getResponse(request());
  await Promise.resolve();
  t.mock.timers.tick(60_000);
  await assert.rejects(pending, { code: 'MODEL_TIMEOUT' });
  assert.equal(providerSignal.aborted, true);
});

test('provider exceptions and error responses cannot leak raw authentication messages', async () => {
  const secret = 'Bearer TOP_SECRET_CREDENTIAL';
  for (const completeSimple of [async () => { throw new Error(secret); }, async () => reply([], { stopReason: 'error', errorMessage: secret })]) {
    const events = [];
    const adapter = createPiModel({ model, sessionId: 'attempt-1', runtime: { completeSimple }, onCall: (event) => events.push(event) });
    await assert.rejects(adapter.getResponse(request()), (error) => error.code === 'MODEL_ERROR' && !error.message.includes(secret));
    assert.equal(events[0].status, 'error');
    assert.equal(events[0].code, 'MODEL_ERROR');
    assert.equal(JSON.stringify(events).includes(secret), false);
  }
});

test('official SDK Runner executes a handoff and tool loop through the adapter without network', async () => {
  const exampleRequire = createRequire(new URL('../examples/openai-customer-service/package.json', import.meta.url));
  const { Agent, Runner, tool, setTracingDisabled } = await import(pathToFileURL(exampleRequire.resolve('@openai/agents')).href);
  setTracingDisabled(true);
  const { z } = await import(pathToFileURL(exampleRequire.resolve('zod')).href);
  const contexts = [];
  let lookups = 0;
  const adapter = createPiModel({ model, sessionId: 'sdk-attempt', runtime: {
    async completeSimple(_, context) {
      contexts.push(context);
      if (contexts.length === 1) return reply([
        { type: 'thinking', thinking: 'internal', thinkingSignature: 'opaque' },
        { type: 'toolCall', id: 'handoff|fc_1', name: context.tools.find((item) => item.name.startsWith('transfer_to_')).name, arguments: {} },
      ], { stopReason: 'toolUse' });
      if (contexts.length === 2) return reply([
        { type: 'toolCall', id: 'lookup|fc_2', name: 'lookup', arguments: { question: 'wifi' } },
      ], { stopReason: 'toolUse' });
      return reply([{ type: 'text', text: '免费 Wi-Fi。' }]);
    },
  } });
  const lookup = tool({ name: 'lookup', description: 'FAQ lookup', parameters: z.object({ question: z.string() }), execute: async ({ question }) => { lookups++; return `free ${question}`; } });
  const faq = new Agent({ name: 'FAQ Agent', model: adapter, instructions: 'Use lookup.', tools: [lookup] });
  const triage = new Agent({ name: 'Triage', model: adapter, instructions: 'Transfer to FAQ.', handoffs: [faq] });
  const result = await new Runner({ tracingDisabled: true }).run(triage, 'wifi?', { maxTurns: 4 });
  assert.equal(result.finalOutput, '免费 Wi-Fi。');
  assert.equal(result.lastAgent.name, 'FAQ Agent');
  assert.equal(lookups, 1);
  assert.equal(contexts.length, 3);
  assert.equal(contexts[2].messages.filter((item) => item.role === 'toolResult').length, 2);
  assert.equal(contexts[2].messages[1].content[0].thinkingSignature, 'opaque');
});
