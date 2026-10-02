import { randomUUID } from 'node:crypto';
import { Usage } from '@openai/agents';

const DEADLINE_MS = 60_000;
const MAX_INPUT_BYTES = 512_000;
const MAX_CACHE_BYTES = 1_000_000;
const MAX_CACHED_ITEMS = 256;
const EMPTY_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const ERRORS = {
  ADAPTER_UNSUPPORTED: '当前模型适配器不支持该请求类型。',
  ADAPTER_INVALID: '模型请求或响应格式不符合约定。',
  ADAPTER_HISTORY: '当前执行无法恢复该历史响应，请使用独立会话重新运行。',
  ADAPTER_LIMIT: '当前执行超出模型适配器的上下文上限。',
  MODEL_CANCELLED: '模型调用已取消。',
  MODEL_TIMEOUT: '模型调用超过 60 秒上限。',
  MODEL_ERROR: '模型调用失败，请检查模型连接后重试。',
};

function failure(code) {
  return Object.assign(new Error(ERRORS[code]), { code });
}

function requireValue(condition, code = 'ADAPTER_INVALID') {
  if (!condition) throw failure(code);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function encoded(value) {
  try {
    const result = JSON.stringify(value);
    requireValue(typeof result === 'string');
    return result;
  } catch { throw failure('ADAPTER_INVALID'); }
}

function textContent(content, allowed) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  requireValue(Array.isArray(content));
  return content.map((part) => {
    requireValue(allowed.includes(part?.type), 'ADAPTER_UNSUPPORTED');
    requireValue(typeof part.text === 'string');
    requireValue(!part.promptCacheBreakpoint, 'ADAPTER_UNSUPPORTED');
    return { type: 'text', text: part.text };
  });
}

function jsonArguments(value) {
  requireValue(typeof value === 'string');
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw failure('ADAPTER_INVALID'); }
  requireValue(object(parsed));
  return parsed;
}

function tokenCount(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/** One factory is one isolated evaluation attempt. Authentication belongs to the injected runtime. */
export function createPiModel({ runtime, model, sessionId, onCall = () => {} }) {
  requireValue(typeof runtime?.completeSimple === 'function' && typeof model?.id === 'string');
  requireValue(typeof sessionId === 'string' && sessionId.length > 0 && typeof onCall === 'function');
  const scope = randomUUID();
  // Only opaque item references leave this closure. Raw thinking and signatures remain case-local.
  const history = new Map();
  let cacheBytes = 0;
  let busy = false;

  function notify(event) {
    // Telemetry must not turn a completed provider call into a retryable model failure.
    try { Promise.resolve(onCall(event)).catch(() => {}); } catch { /* Observer owns persistence errors. */ }
  }

  function assistant(content, source = {}) {
    return {
      role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
      usage: structuredClone(EMPTY_USAGE), stopReason: content.some((part) => part.type === 'toolCall') ? 'toolUse' : 'stop',
      timestamp: Date.now(), ...source,
    };
  }

  function convertInput(input) {
    const items = typeof input === 'string' ? [{ role: 'user', content: input }] : input;
    requireValue(Array.isArray(items));
    const messages = [];
    const addAssistant = (content, source) => {
      const last = messages.at(-1);
      if (last?.role === 'assistant') {
        last.content.push(...content);
        if (content.some((part) => part.type === 'toolCall')) last.stopReason = 'toolUse';
      } else messages.push(assistant(content, source));
    };
    for (const item of items) {
      requireValue(object(item));
      if (item.providerData?.evalpiPi) {
        const remembered = history.get(item.id);
        requireValue(item.providerData.evalpiPi.scope === scope && remembered?.fingerprint === encoded(item), 'ADAPTER_HISTORY');
        addAssistant([structuredClone(remembered.block)], remembered.source);
      } else if ((!item.type || item.type === 'message') && item.role === 'user') {
        messages.push({ role: 'user', content: textContent(item.content, ['input_text']), timestamp: Date.now() });
      } else if ((!item.type || item.type === 'message') && item.role === 'system') {
        requireValue(typeof item.content === 'string');
        messages.push({ role: 'system', content: item.content });
      } else if ((!item.type || item.type === 'message') && item.role === 'assistant') {
        addAssistant(textContent(item.content, ['output_text']));
      } else if (item.type === 'function_call') {
        requireValue(typeof item.callId === 'string' && typeof item.name === 'string');
        requireValue(!item.namespace && !item.caller, 'ADAPTER_UNSUPPORTED');
        addAssistant([{ type: 'toolCall', id: item.callId, name: item.name, arguments: jsonArguments(item.arguments) }]);
      } else if (item.type === 'function_call_result') {
        requireValue(typeof item.callId === 'string' && typeof item.name === 'string');
        requireValue(!item.namespace && !item.caller, 'ADAPTER_UNSUPPORTED');
        const output = object(item.output) ? [item.output] : item.output;
        messages.push({
          role: 'toolResult', toolCallId: item.callId, toolName: item.name,
          content: textContent(output, ['input_text', 'text']), isError: item.status === 'incomplete', timestamp: Date.now(),
        });
      } else throw failure('ADAPTER_UNSUPPORTED');
    }
    return messages;
  }

  function convertTools(request) {
    const tools = (request.tools ?? []).map((tool) => {
      requireValue(tool.type === 'function', 'ADAPTER_UNSUPPORTED');
      requireValue(!tool.namespace && !tool.deferLoading && !tool.allowedCallers, 'ADAPTER_UNSUPPORTED');
      return { name: tool.name, description: tool.description, parameters: tool.parameters, strict: tool.strict };
    });
    for (const handoff of request.handoffs ?? []) tools.push({
      name: handoff.toolName, description: handoff.toolDescription,
      parameters: handoff.inputJsonSchema, strict: handoff.strictJsonSchema,
    });
    const names = new Set();
    return tools.map((tool) => {
      requireValue(typeof tool.name === 'string' && typeof tool.description === 'string' && object(tool.parameters));
      requireValue(!names.has(tool.name));
      names.add(tool.name);
      return {
        name: tool.name, description: tool.description, parameters: structuredClone(tool.parameters),
        ...(tool.strict ? { constrainedSampling: { type: 'json_schema', strict: 'prefer' } } : {}),
      };
    });
  }

  function convertResponse(response) {
    requireValue(response?.role === 'assistant' && Array.isArray(response.content));
    if (response.stopReason === 'aborted') throw failure('MODEL_CANCELLED');
    if (response.stopReason === 'error') throw failure('MODEL_ERROR');
    requireValue(['stop', 'toolUse', 'length'].includes(response.stopReason), 'ADAPTER_UNSUPPORTED');
    const responseId = randomUUID();
    const staged = response.content.map((block, index) => {
      const id = `pi_${randomUUID().replaceAll('-', '')}`;
      const base = { id, providerData: { evalpiPi: { scope, responseId, index } } };
      let item;
      if (block.type === 'text') {
        requireValue(typeof block.text === 'string');
        item = { ...base, type: 'message', role: 'assistant', status: response.stopReason === 'length' ? 'incomplete' : 'completed', content: [{ type: 'output_text', text: block.text }] };
      } else if (block.type === 'toolCall') {
        requireValue(typeof block.id === 'string' && typeof block.name === 'string' && object(block.arguments));
        requireValue(!block.namespace, 'ADAPTER_UNSUPPORTED');
        item = { ...base, type: 'function_call', callId: block.id, name: block.name, arguments: encoded(block.arguments), status: 'completed' };
      } else if (block.type === 'thinking') {
        requireValue(typeof block.thinking === 'string');
        // The SDK needs a replay marker, not the provider's private reasoning payload.
        item = { ...base, type: 'reasoning', content: [] };
      } else throw failure('ADAPTER_UNSUPPORTED');
      const source = { api: response.api, provider: response.provider, model: response.model, timestamp: response.timestamp };
      for (const key of ['responseId', 'responseModel', 'providerThinkingLevel', 'thinkingLevel']) {
        if (response[key] !== undefined) source[key] = response[key];
      }
      const remembered = { fingerprint: encoded(item), block: structuredClone(block), source };
      return { item, remembered, bytes: Buffer.byteLength(encoded(remembered)) };
    });
    requireValue(staged.length > 0);
    const bytes = staged.reduce((sum, item) => sum + item.bytes, 0);
    requireValue(history.size + staged.length <= MAX_CACHED_ITEMS && cacheBytes + bytes <= MAX_CACHE_BYTES, 'ADAPTER_LIMIT');
    for (const entry of staged) history.set(entry.item.id, entry.remembered);
    cacheBytes += bytes;
    const raw = response.usage ?? {};
    const inputTokens = tokenCount(raw.input) + tokenCount(raw.cacheRead) + tokenCount(raw.cacheWrite);
    const outputTokens = tokenCount(raw.output);
    const usage = new Usage({
      requests: 1, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
      inputTokensDetails: [{ cached_tokens: tokenCount(raw.cacheRead) }],
      outputTokensDetails: [{ reasoning_tokens: tokenCount(raw.reasoning) }],
    });
    return { usage, output: staged.map((entry) => entry.item) };
  }

  return {
    async getResponse(request) {
      requireValue(object(request));
      if (request?.signal?.aborted) throw failure('MODEL_CANCELLED');
      requireValue(!busy, 'ADAPTER_INVALID');
      requireValue(!request.previousResponseId && !request.conversationId && !request.prompt, 'ADAPTER_UNSUPPORTED');
      requireValue(request.outputType === undefined || request.outputType === 'text', 'ADAPTER_UNSUPPORTED');
      requireValue(request.systemInstructions === undefined || typeof request.systemInstructions === 'string');
      requireValue(Buffer.byteLength(encoded(request.input)) <= MAX_INPUT_BYTES, 'ADAPTER_LIMIT');
      const settings = request.modelSettings ?? {};
      requireValue(settings.toolChoice === undefined || ['auto', 'none'].includes(settings.toolChoice), 'ADAPTER_UNSUPPORTED');
      const context = { systemPrompt: request.systemInstructions ?? '', messages: convertInput(request.input), tools: convertTools(request) };
      requireValue(Buffer.byteLength(encoded(context)) <= MAX_INPUT_BYTES, 'ADAPTER_LIMIT');
      const controller = new AbortController();
      let timer;
      let timedOut = false;
      let abortListener;
      const started = Date.now();
      busy = true;
      try {
        const interrupted = new Promise((_, reject) => {
          abortListener = () => {
            controller.abort();
            reject(failure('MODEL_CANCELLED'));
          };
          request.signal?.addEventListener('abort', abortListener, { once: true });
          timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(failure('MODEL_TIMEOUT'));
          }, DEADLINE_MS);
        });
        const work = Promise.resolve().then(() => {
          if (controller.signal.aborted) throw failure(timedOut ? 'MODEL_TIMEOUT' : 'MODEL_CANCELLED');
          return runtime.completeSimple(model, context, {
            signal: controller.signal, reasoning: 'low', maxTokens: 1800, maxRetries: 0,
            cacheRetention: 'none', sessionId, timeoutMs: DEADLINE_MS,
            ...(settings.toolChoice ? { toolChoice: settings.toolChoice } : {}),
          });
        });
        const raw = await Promise.race([work, interrupted]);
        if (request.signal?.aborted || timedOut) throw failure(timedOut ? 'MODEL_TIMEOUT' : 'MODEL_CANCELLED');
        const result = convertResponse(raw);
        notify({
          status: 'completed', durationMs: Date.now() - started, sessionId, provider: model.provider, model: model.id,
          usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, totalTokens: result.usage.totalTokens },
          toolCalls: result.output.filter((item) => item.type === 'function_call').map((item) => ({ callId: item.callId, name: item.name, arguments: JSON.parse(item.arguments) })),
          reply: result.output.filter((item) => item.type === 'message').flatMap((item) => item.content.map((part) => part.text)).join('\n'),
        });
        return result;
      } catch (error) {
        const code = timedOut ? 'MODEL_TIMEOUT' : request.signal?.aborted ? 'MODEL_CANCELLED' : Object.hasOwn(ERRORS, error?.code) ? error.code : 'MODEL_ERROR';
        notify({ status: 'error', code, durationMs: Date.now() - started, sessionId, provider: model.provider, model: model.id });
        throw failure(code);
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', abortListener);
        busy = false;
      }
    },
    async *getStreamedResponse() { throw failure('ADAPTER_UNSUPPORTED'); },
    getRetryAdvice() { return { suggested: false, replaySafety: 'unsafe' }; },
  };
}
