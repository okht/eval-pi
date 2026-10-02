import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/http.mjs';

async function setup(t, options = {}) {
  const temporaryRoot = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(temporaryRoot, 'evalpi-http-test-'));
  const appRoot = path.join(directory, 'app');
  const dataDir = path.join(directory, 'data');
  for (const sub of ['dist/assets', 'public/fonts', 'public/private']) await mkdir(path.join(appRoot, sub), { recursive: true });
  await mkdir(path.join(dataDir, 'reports'), { recursive: true });
  await writeFile(path.join(appRoot, 'dist/index.html'), '<!doctype html><title>EvalPi</title>');
  await writeFile(path.join(appRoot, 'dist/assets/app.js'), 'console.log("build")');
  await writeFile(path.join(appRoot, 'public/fonts/test.woff2'), 'font');
  await writeFile(path.join(appRoot, 'public/evalpi.svg'), '<svg/>');
  await writeFile(path.join(appRoot, 'public/private/credential.txt'), 'PRIVATE_SENTINEL');
  await writeFile(path.join(appRoot, 'dist/.env'), 'PRIVATE_SENTINEL');
  await writeFile(path.join(dataDir, 'workspace.json'), 'PRIVATE_SENTINEL');
  await writeFile(path.join(dataDir, 'reports/report-123.html'), '<html>report</html>');
  await writeFile(path.join(dataDir, 'reports/results.csv'), 'id,verdict\n1,pass');
  const calls = [];
  const runtime = { events: new EventEmitter(), snapshot: () => ({ busy: false, messages: [] }) };
  for (const method of ['selectProject', 'example', 'configure', 'login', 'submitLoginCode', 'cancelLogin', 'message', 'confirm', 'start', 'retryGrading', 'cancel', 'review', 'report']) {
    runtime[method] = async (argument) => { calls.push([method, argument]); return { ok: true, method }; };
  }
  const service = await startServer({ runtime, appRoot, dataDir, port: 0, ...options });
  t.after(async () => {
    await service.close();
    const relative = path.relative(temporaryRoot, path.resolve(directory));
    assert.ok(relative.startsWith('evalpi-http-test-') && !relative.includes(path.sep));
    await rm(directory, { recursive: true, force: true });
  });
  return { ...service, runtime, calls, appRoot, dataDir, directory };
}

function request(service, route, { method = 'GET', headers = {}, body, chunks } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(service.url);
    const req = http.request({ hostname: url.hostname, port: url.port, path: route, method, headers, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (chunks) { for (const chunk of chunks) req.write(chunk); req.end(); }
    else req.end(body);
  });
}

const clientHeaders = { 'Content-Type': 'application/json', 'X-EvalPi-Client': 'desktop-v1' };

test('binds only IPv4 loopback and exposes state with restrictive browser headers', async (t) => {
  const service = await setup(t);
  assert.equal(service.server.address().address, '127.0.0.1');
  const response = await request(service, '/api/state');
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.text), service.runtime.snapshot());
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.match(response.headers['content-security-policy'], /script-src 'self'/);
  assert.match(response.headers['content-security-policy'], /frame-ancestors 'self'/);
  assert.match(response.headers['content-security-policy'], /font-src 'self' data:/);
});

test('rejects foreign Host, Origin and cross-site reads without Origin', async (t) => {
  const service = await setup(t);
  for (const headers of [
    { Host: 'evil.example:4317' }, { Host: '127.0.0.1:9999' },
    { Origin: 'https://evil.example' }, { Origin: 'null' }, { Origin: '' },
    { 'Sec-Fetch-Site': 'cross-site' }, { Origin: service.url, 'Sec-Fetch-Site': 'cross-site' },
  ]) {
    const response = await request(service, '/api/state', { headers });
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  assert.equal((await request(service, '/api/state', { headers: { Origin: service.url, 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
  assert.equal((await request(service, '/api/events', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal(service.runtime.events.listenerCount('event'), 0);
});

test('POST requires explicit client header plus JSON and refuses browser form requests', async (t) => {
  const service = await setup(t);
  for (const [headers, expected] of [
    [{ 'Content-Type': 'application/json' }, 403],
    [{ 'X-EvalPi-Client': 'desktop-v1', 'Content-Type': 'text/plain' }, 415],
    [{ 'X-EvalPi-Client': 'desktop-v1', 'Content-Type': 'application/x-www-form-urlencoded' }, 415],
    [{ ...clientHeaders, Origin: 'https://evil.example' }, 403],
    [{ ...clientHeaders, 'Sec-Fetch-Site': 'cross-site' }, 403],
  ]) assert.equal((await request(service, '/api/run', { method: 'POST', headers, body: '{}' })).status, expected);
  assert.equal(service.calls.length, 0);
  assert.equal((await request(service, '/api/run', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } })).status, 403);
});

test('maps all application POST routes and preserves argument shapes', async (t) => {
  const service = await setup(t);
  const cases = [
    ['/api/project', { path: 'project' }, 'selectProject', 'project'],
    ['/api/example', {}, 'example', undefined],
    ['/api/model', { provider: 'openai', model: 'selected-model' }, 'configure', { provider: 'openai', model: 'selected-model' }],
    ['/api/auth/login', {}, 'login', undefined],
    ['/api/auth/code', { code: 'callback' }, 'submitLoginCode', 'callback'],
    ['/api/auth/cancel', {}, 'cancelLogin', undefined],
    ['/api/message', { text: 'goal' }, 'message', 'goal'],
    ['/api/plan/confirm', { planId: 'p1' }, 'confirm', 'p1'],
    ['/api/run', { planId: 'p1' }, 'start', 'p1'],
    ['/api/run/retry-grading', { runId: 'r1' }, 'retryGrading', 'r1'],
    ['/api/cancel', {}, 'cancel', undefined],
    ['/api/review', { decisions: { c1: 'issue' } }, 'review', { c1: 'issue' }],
    ['/api/report', {}, 'report', undefined],
  ];
  for (const [route, body, method, argument] of cases) {
    const response = await request(service, route, { method: 'POST', headers: clientHeaders, body: JSON.stringify(body) });
    assert.equal(response.status, 200, route);
    assert.deepEqual(service.calls.at(-1), [method, argument]);
  }
  assert.equal((await request(service, '/api/nope', { method: 'POST', headers: clientHeaders, body: '{}' })).status, 404);
});

test('rejects malformed, non-object and oversized request bodies, including chunked bodies', async (t) => {
  const service = await setup(t);
  for (const body of ['{', '[]', 'null', '"string"']) assert.equal((await request(service, '/api/message', { method: 'POST', headers: clientHeaders, body })).status, 400);
  const oversized = JSON.stringify({ text: 'x'.repeat(1024 * 1024) });
  assert.equal((await request(service, '/api/message', { method: 'POST', headers: { ...clientHeaders, 'Content-Length': Buffer.byteLength(oversized) }, body: oversized })).status, 413);
  assert.equal((await request(service, '/api/message', { method: 'POST', headers: clientHeaders, chunks: [oversized.slice(0, 600_000), oversized.slice(600_000)] })).status, 413);
  assert.equal(service.calls.length, 0);
});

test('repeated concurrent oversized requests reliably return 413 and leave the server usable', async (t) => {
  const service = await setup(t);
  const oversized = JSON.stringify({ text: 'x'.repeat(1024 * 1024 + 65_536) });
  const chunks = [];
  for (let offset = 0; offset < oversized.length; offset += 65_536) chunks.push(oversized.slice(offset, offset + 65_536));
  for (let iteration = 0; iteration < 12; iteration++) {
    const responses = await Promise.all([
      request(service, '/api/message', { method: 'POST', headers: { ...clientHeaders, 'Content-Length': Buffer.byteLength(oversized) }, body: oversized }),
      request(service, '/api/message', { method: 'POST', headers: clientHeaders, chunks }),
    ]);
    for (const response of responses) {
      assert.equal(response.status, 413, `iteration ${iteration}`);
      assert.match(JSON.parse(response.text).error, /1 MiB/);
    }
  }
  assert.equal(service.calls.length, 0);
  const valid = await request(service, '/api/message', { method: 'POST', headers: clientHeaders, body: JSON.stringify({ text: 'still works' }) });
  assert.equal(valid.status, 200);
  assert.deepEqual(service.calls, [['message', 'still works']]);
});

test('SSE sends initial state then events and unregisters when the client disconnects', async (t) => {
  const service = await setup(t);
  const frames = await new Promise((resolve, reject) => {
    const req = http.get(`${service.url}/api/events`, (res) => {
      assert.equal(res.statusCode, 200);
      assert.match(res.headers['content-type'], /text\/event-stream/);
      let buffer = '';
      let emitted = false;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        if (!emitted && buffer.includes('"state"')) { emitted = true; service.runtime.events.emit('event', { type: 'delta', text: '新进度' }); }
        if (buffer.includes('新进度')) { res.destroy(); resolve(buffer.split('\n\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)))); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('SSE test timed out')); });
  });
  assert.deepEqual(frames, [{ type: 'state', state: service.runtime.snapshot() }, { type: 'delta', text: '新进度' }]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(service.runtime.events.listenerCount('event'), 0);
});

test('report files are flat, HTML inline and other evidence attachments', async (t) => {
  const service = await setup(t);
  const html = await request(service, '/api/files/report-123.html');
  assert.equal(html.status, 200);
  assert.match(html.headers['content-disposition'], /^inline;/);
  const csv = await request(service, '/api/files/results.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.headers['content-disposition'], /^attachment;/);
  for (const route of ['/api/files/../workspace.json', '/api/files/%2e%2e%2fworkspace.json', '/api/files/%2eenv', '/api/files/a/b.json', '/api/files/中文.json', '/api/files/a%5c..%5cworkspace.json']) {
    assert.equal((await request(service, encodeURI(route).replaceAll('%25', '%'))).status, 403, route);
  }
});

test('serves only build assets and whitelisted public fonts or logo, with no traversal', async (t) => {
  const service = await setup(t);
  for (const route of ['/', '/demo', '/report-preview', '/assets/app.js', '/fonts/test.woff2', '/evalpi.svg']) assert.equal((await request(service, route)).status, 200, route);
  for (const route of ['/.env', '/%2eenv', '/assets/../../private.txt', '/assets/%2e%2e/%2e%2e/private.txt']) assert.equal((await request(service, route)).status, 403, route);
  for (const route of ['/workspace.json', '/public/private/credential.txt', '/private/credential.txt']) {
    const response = await request(service, route);
    assert.equal(response.status, 404, route);
    assert.equal(response.text.includes('PRIVATE_SENTINEL'), false);
  }
});

test('refuses symlinked static directory resources', async (t) => {
  const service = await setup(t);
  const outside = path.join(service.directory, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'leak.txt'), 'PRIVATE_SENTINEL');
  await symlink(outside, path.join(service.appRoot, 'dist', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await request(service, '/linked/leak.txt')).status, 403);
});

test('runtime errors return a redacted message without stack or credentials', async (t) => {
  const service = await setup(t);
  service.runtime.configure = async () => { throw new Error('failed Authorization: Bearer sensitive-token apiKey=private-value sk-privateABC {"apiKey":"quoted-secret"}\n    at private/file.mjs:10'); };
  const response = await request(service, '/api/model', { method: 'POST', headers: clientHeaders, body: '{}' });
  assert.equal(response.status, 400);
  const error = JSON.parse(response.text);
  assert.equal(Object.hasOwn(error, 'stack'), false);
  for (const secret of ['sensitive-token', 'private-value', 'sk-privateABC', 'quoted-secret', 'private/file.mjs']) assert.equal(response.text.includes(secret), false);
});

test('allows the explicit loopback Vite origin without enabling CORS', async (t) => {
  const service = await setup(t, { allowedOrigins: ['http://127.0.0.1:5173'] });
  const response = await request(service, '/api/state', { headers: { Origin: 'http://127.0.0.1:5173', 'Sec-Fetch-Site': 'same-site' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.match(response.headers['content-security-policy'], /connect-src 'self' http:\/\/127\.0\.0\.1:5173/);
  assert.equal((await request(service, '/api/state', { headers: { Origin: 'http://127.0.0.1:5174' } })).status, 403);
});
