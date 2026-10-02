import type { AppState, RuntimeEvent } from '../shared/contracts';

const API_ROOT = '/api';

export class RuntimeError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'RuntimeError';
  }
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_ROOT}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? { Accept: 'application/json' } : {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-EvalPi-Client': 'desktop-v1',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new RuntimeError('无法连接本机运行服务。请启动 EvalPi 桌面应用，或运行 npm run dev:full 后重试。');
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new RuntimeError('本机运行服务尚未启动。当前页面需要 EvalPi 服务，请运行 npm run dev:full 后重试。', response.status);
  }
  const data: unknown = await response.json();
  if (!response.ok) {
    const message = typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string'
      ? data.error : `请求未完成（${response.status}），请稍后重试。`;
    throw new RuntimeError(message, response.status);
  }
  return data as T;
}

export const getRuntimeState = () => request<AppState>('/state');
export const postRuntime = <T = { ok: boolean }>(path: string, body: unknown = {}) => request<T>(path, body);

export function subscribeRuntime(handlers: {
  onEvent: (event: RuntimeEvent) => void;
  onConnected: () => void;
  onDisconnected: () => void;
}): () => void {
  const source = new EventSource(`${API_ROOT}/events`);
  source.onopen = handlers.onConnected;
  source.onerror = handlers.onDisconnected;
  source.onmessage = event => {
    try {
      const data: RuntimeEvent = JSON.parse(event.data);
      if (data.type === 'state' || data.type === 'delta') handlers.onEvent(data);
    } catch {
      // A malformed event must not replace the last known server state.
      handlers.onDisconnected();
    }
  };
  return () => source.close();
}

export function runtimeFileUrl(path: string): string {
  const url = new URL(path, window.location.origin);
  if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/files/')) {
    throw new RuntimeError('服务返回的报告地址无效，请重新生成报告。');
  }
  return url.href;
}
