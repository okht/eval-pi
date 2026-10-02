import http from 'node:http';
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

const BODY_LIMIT = 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.pdf': 'application/pdf', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.txt': 'text/plain; charset=utf-8',
};

function problem(status, message) { return Object.assign(new Error(message), { status }); }

function safeError(error) {
  if (error?.code === 'ENOENT') return '所需文件不存在，请检查项目或重新生成报告。';
  if (['EACCES', 'EPERM'].includes(error?.code)) return '当前没有访问所需文件的权限。';
  if (error?.code === 'EEXIST') return '目标文件已存在，请重新创建本次运行。';
  return String(error?.message ?? '请求未能完成，请重试。').slice(0, 1200)
    .replace(/\bBearer\s+[^\s,;"'<>]+/gi, 'Bearer [已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[已隐藏]')
    .replace(/(["'](?:api[-_ ]?key|access_token|refresh_token|id_token|authorization|password|secret)["']\s*:\s*["'])[^"']*(["'])/gi, '$1[已隐藏]$2')
    .replace(/((?:api[-_ ]?key|access_token|refresh_token|id_token|authorization|password|secret)\s*[=:]\s*)[^\s,;"'<>]+/gi, '$1[已隐藏]')
    .replace(/([?&](?:key|token|code|client_secret)=)[^\s&#]+/gi, '$1[已隐藏]')
    .replace(/https?:\/\/[^\s/:@]+:[^\s/@]+@/gi, 'https://[已隐藏]@')
    .replace(/[A-Za-z]:[\\/][^\r\n"'<>]*/g, '[本地路径]')
    .split(/\n\s*at /)[0];
}

function json(res, status, body) {
  if (res.writableEnded || res.destroyed) return;
  const data = JSON.stringify(body ?? { ok: true });
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store' });
  res.end(data);
}

function parsePath(rawUrl) {
  let pathname;
  try { pathname = decodeURIComponent((rawUrl ?? '/').split(/[?#]/, 1)[0]); }
  catch { throw problem(400, '请求路径编码无效。'); }
  if (!pathname.startsWith('/') || pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some((part) => part.startsWith('.'))) {
    throw problem(403, '该路径不可访问。');
  }
  return pathname;
}

function localOrigin(origin) {
  try {
    const value = new URL(origin);
    if (value.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(value.hostname) || value.username || value.password || value.pathname !== '/' || value.search || value.hash) return null;
    return value.origin;
  } catch { return null; }
}

async function publicFile(root, relative) {
  const parts = relative.split('/');
  if (!relative || parts.some((part) => !part || part.startsWith('.') || part.includes('\\') || part.includes('\0'))) throw problem(403, '该文件不可访问。');
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw problem(403, '资源目录不可使用符号链接。');
  const canonicalRoot = await realpath(root);
  let filename = canonicalRoot;
  for (const segment of parts) {
    filename = path.join(filename, segment);
    const info = await lstat(filename);
    if (info.isSymbolicLink()) throw problem(403, '资源不可使用符号链接。');
  }
  const relativeResolved = path.relative(canonicalRoot, filename);
  if (!relativeResolved || relativeResolved.startsWith('..') || path.isAbsolute(relativeResolved)) throw problem(403, '该文件超出公开目录。');
  const info = await lstat(filename);
  if (!info.isFile() || await realpath(filename) !== filename) throw problem(403, '该资源不可访问。');
  return { filename, size: info.size };
}

async function sendFile(req, res, root, relative, download = false) {
  const file = await publicFile(root, relative);
  const extension = path.extname(file.filename).toLowerCase();
  const headers = { 'Content-Type': MIME[extension] ?? 'application/octet-stream', 'Content-Length': file.size, 'Cache-Control': 'no-store' };
  if (download) headers['Content-Disposition'] = `${extension === '.html' ? 'inline' : 'attachment'}; filename="${path.basename(relative)}"`;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  const stream = createReadStream(file.filename);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

async function bodyJson(req) {
  if (req.headers['x-evalpi-client'] !== 'desktop-v1') throw problem(403, '缺少本机应用请求标识。');
  if (!/^application\/json(?:\s*;[^\r\n]*)?$/i.test(req.headers['content-type'] ?? '')) throw problem(415, '请求需要使用 application/json。');
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw problem(415, '不支持压缩请求正文。');
  const statedLength = Number(req.headers['content-length']);
  const chunks = await new Promise((resolve, reject) => {
    const buffered = [];
    let size = 0;
    let oversized = Number.isFinite(statedLength) && statedLength > BODY_LIMIT;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('aborted', onAborted);
      // Keep the error handler through close: an aborted IncomingMessage may
      // emit ECONNRESET after its aborted event. It must never escape the server.
      if (error) reject(error);
      else resolve(buffered);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) oversized = true;
      if (oversized) buffered.length = 0;
      else buffered.push(chunk);
    };
    const onEnd = () => finish(oversized ? problem(413, '请求正文不能超过 1 MiB。') : undefined);
    const onAborted = () => finish(problem(400, '请求正文传输中断。'));
    const onError = () => finish(problem(400, '请求正文读取失败。'));
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('aborted', onAborted);
    req.on('error', onError);
    req.once('close', () => req.off('error', onError));
    // Explicit event consumption drains oversized bodies without buffering them.
    // Throwing inside for-await would destroy the socket before the 413 response.
  });
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw problem(400, '请求正文需要是有效 JSON 对象。'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw problem(400, '请求正文需要是 JSON 对象。');
  return body;
}

export async function startServer({ runtime, dataDir, appRoot, port = 4317, allowedOrigins = [] }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('本地端口无效。');
  const developmentOrigins = new Set(allowedOrigins.map(localOrigin).filter(Boolean));
  if (developmentOrigins.size !== allowedOrigins.length) throw new Error('开发来源仅支持明确的本机 HTTP 地址。');
  const connections = new Set();
  let boundPort;
  let closed = false;
  const csp = [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "font-src 'self' data:",
    "img-src 'self' data: blob:", `connect-src 'self'${developmentOrigins.size ? ` ${[...developmentOrigins].join(' ')}` : ''}`,
    "frame-src 'self'", "frame-ancestors 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
  ].join('; ');

  function verifyLocalRequest(req) {
    const hosts = req.rawHeaders.filter((_value, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === 'host');
    if (hosts.length !== 1 || ![`127.0.0.1:${boundPort}`, `localhost:${boundPort}`].includes(req.headers.host?.toLowerCase())) throw problem(403, '请求主机不属于此本地应用。');
    const origin = req.headers.origin;
    if (origin !== undefined) {
      const normalized = localOrigin(origin);
      if (!normalized || (!developmentOrigins.has(normalized) && ![`http://127.0.0.1:${boundPort}`, `http://localhost:${boundPort}`].includes(normalized))) throw problem(403, '拒绝来自其他网站的请求。');
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') throw problem(403, '拒绝跨站请求。');
  }

  const postRoutes = {
    '/api/project': (body) => runtime.selectProject(body.path),
    '/api/example': () => runtime.example(),
    '/api/model': (body) => runtime.configure(body),
    '/api/auth/login': () => runtime.login(),
    '/api/auth/code': (body) => runtime.submitLoginCode(body.code),
    '/api/auth/cancel': () => runtime.cancelLogin(),
    '/api/message': (body) => runtime.message(body.text),
    '/api/plan/confirm': (body) => runtime.confirm(body.planId),
    '/api/run': (body) => runtime.start(body.planId),
    '/api/run/retry-grading': (body) => runtime.retryGrading(body.runId),
    '/api/cancel': () => runtime.cancel(),
    '/api/review': (body) => runtime.review(body.decisions),
    '/api/report': () => runtime.report(),
  };

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    try {
      verifyLocalRequest(req);
      const pathname = parsePath(req.url);
      if (pathname.startsWith('/api/')) {
        if (req.method === 'POST') {
          const body = await bodyJson(req);
          if (!Object.hasOwn(postRoutes, pathname)) throw problem(404, '接口不存在。');
          json(res, 200, await postRoutes[pathname](body));
          return;
        }
        if (req.method !== 'GET') throw problem(405, '此接口不支持该请求方法。');
        if (pathname === '/api/state') { json(res, 200, runtime.snapshot()); return; }
        if (pathname === '/api/events') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          res.flushHeaders();
          const send = (event) => {
            if (res.writableEnded || res.destroyed) return;
            if (res.writableLength > 8 * 1024 * 1024) { res.end(); return; }
            try { res.write(`data: ${JSON.stringify(event)}\n\n`); }
            catch { res.end(); }
          };
          const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': keepalive\n\n'); }, 15000);
          heartbeat.unref();
          runtime.events.on('event', send);
          connections.add(res);
          res.on('close', () => { clearInterval(heartbeat); runtime.events.off('event', send); connections.delete(res); });
          send({ type: 'state', state: runtime.snapshot() });
          return;
        }
        if (pathname.startsWith('/api/files/')) {
          const filename = pathname.slice('/api/files/'.length);
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(filename)) throw problem(403, '报告文件名无效。');
          await sendFile(req, res, path.join(dataDir, 'reports'), filename, true);
          return;
        }
        throw problem(404, '接口不存在。');
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw problem(405, '静态资源只支持读取。');
      const relative = ['/', '/demo', '/demo/', '/report-preview', '/report-preview/'].includes(pathname) ? 'index.html' : pathname.slice(1);
      try {
        await sendFile(req, res, path.join(appRoot, 'dist'), relative);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (/^fonts\/[A-Za-z0-9][A-Za-z0-9._/-]*\.(?:woff2?|ttf|otf)$/i.test(relative)) await sendFile(req, res, path.join(appRoot, 'public'), relative);
        else if (relative === 'evalpi.svg') await sendFile(req, res, path.join(appRoot, 'public'), relative);
        else throw problem(404, '页面或资源不存在。');
      }
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      const status = Number.isInteger(error.status) ? error.status : error.code === 'ENOENT' ? 404 : 400;
      json(res, status, { error: safeError(error) });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); boundPort = server.address().port; resolve(); });
  });
  return {
    url: `http://127.0.0.1:${boundPort}`,
    server,
    async close() {
      if (closed) return;
      closed = true;
      for (const res of connections) res.end();
      await new Promise((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); });
    },
  };
}
