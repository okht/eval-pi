import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Disable external trace export before the SDK loads; evidence stays in the trial output.
process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!request.sessionId || !Array.isArray(request.input?.messages) || request.input.messages.length < 1 || request.input.messages.length > 4 || request.input.messages.some(value => typeof value !== 'string')) {
    throw Object.assign(new Error('Invalid case input'), { code: 'INVALID_CASE_INPUT' });
  }
  const provenance = JSON.parse(await readFile(new URL('./upstream/provenance.json', import.meta.url), 'utf8'));
  for (const [file, expected] of [['index.ts.txt', provenance.originalSha256], ['agents.mjs', provenance.generatedSha256]]) {
    const bytes = await readFile(new URL(`./upstream/${file}`, import.meta.url));
    if (createHash('sha256').update(bytes).digest('hex') !== expected) throw Object.assign(new Error('Source hash mismatch'), { code: 'SOURCE_CHANGED' });
  }
  // This local file contains only an app-owned credential-store path and model selection.
  // The SDK reads/refreshes its own store; tokens never enter the case or its artifacts.
  const local = JSON.parse(await readFile(new URL('./.evalpi-local.json', import.meta.url), 'utf8'));
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const runtime = await ModelRuntime.create({ authPath: local.authPath, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const model = runtime.getModel(local.provider, local.model);
  if (!model || !(await runtime.checkAuth(local.provider))) throw Object.assign(new Error('Model not connected'), { code: 'MODEL_AUTH' });
  const { Runner, setTracingDisabled } = await import('@openai/agents');
  setTracingDisabled(true);
  const { createPiModel } = await import('./pi-model.mjs');
  const { triageAgent } = await import('./upstream/agents.mjs');
  const trace = [];
  const context = {};
  let turn = 0;
  let toolCalls = 0;
  let handoffs = 0;
  let currentAgent = triageAgent;
  let history = [];
  let completion = { status: 'completed' };
  const replies = [];
  const turns = [];
  const add = (type, fields) => trace.push({ type, turn, ...fields });
  const piModel = createPiModel({ runtime, model, sessionId: request.sessionId, onCall: (event) => add('model_call', event) });
  const runner = new Runner({ model: piModel, tracingDisabled: true });
  runner.on('agent_start', (_context, agent) => add('agent_start', { agent: agent.name }));
  runner.on('agent_handoff', (_context, from, to) => { handoffs++; add('handoff', { from: from.name, to: to.name }); });
  runner.on('agent_tool_start', (_context, agent, tool, details) => {
    toolCalls++;
    add('tool_call', { agent: agent.name, name: tool.name, call: details.toolCall });
  });
  runner.on('agent_tool_end', (_context, agent, tool, result, details) => add('tool_result', {
    agent: agent.name, name: tool.name, call: details.toolCall, result, contextAfter: structuredClone(context),
  }));
  for (const message of request.input.messages) {
    turn++;
    history.push({ role: 'user', content: message });
    try {
      const result = await runner.run(currentAgent, history, { context, maxTurns: 6 });
      const reply = typeof result.finalOutput === 'string' ? result.finalOutput : JSON.stringify(result.finalOutput ?? '');
      replies.push(reply);
      turns.push({ turn, reply, contextAfter: structuredClone(context), agent: result.lastAgent?.name });
      add('assistant', { reply, agent: result.lastAgent?.name });
      history = result.history;
      currentAgent = result.lastAgent ?? currentAgent;
    } catch (error) {
      if (error.name !== 'MaxTurnsExceededError') throw error;
      completion = { status: 'turn_limit', code: 'MAX_AGENT_TURNS', maxTurns: 6, turn };
      add('agent_stopped', completion);
      break;
    }
  }
  const observed = { initialContext: {}, context, completion, turns, toolCalls, handoffs };
  await writeFile('business-state.json', JSON.stringify(observed, null, 2));
  process.stdout.write(JSON.stringify({
    reply: replies.at(-1) ?? '', replies, completion, trace,
    target: { repository: provenance.repository, commit: provenance.commit, sdkVersion: provenance.sdkVersion, provider: local.provider, model: local.model, businessEnvironment: provenance.businessEnvironment },
  }));
}

main().catch(error => {
  const allowed = new Set(['INVALID_CASE_INPUT', 'SOURCE_CHANGED', 'MODEL_AUTH', 'MODEL_TIMEOUT', 'MODEL_CANCELLED', 'MODEL_ERROR', 'MODEL_INVALID_OUTPUT', 'ADAPTER_UNSUPPORTED', 'ADAPTER_INVALID', 'ADAPTER_HISTORY', 'ADAPTER_LIMIT']);
  process.stderr.write(`Open-source target failed: ${allowed.has(error?.code) ? error.code : 'TARGET_ADAPTER_ERROR'}\n`);
  process.exitCode = 1;
});
