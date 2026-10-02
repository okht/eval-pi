import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../server/mcp.mjs';

const sessionId = '9b27b619-2b30-45c0-a9e5-34068ba401d5';
const planId = 'd00e96ec-7fde-4e68-a04a-af64be6d5d1a';
const runId = 'run-455151b1-ce74-4e25-9671-4734f499e03a';
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plan = {
  title: 'Refund policy', goal: 'Confirm refunds follow the policy.', criteria: ['Only eligible orders are refunded.'],
  cases: [{ id: 'refund_1', name: 'Eligible order', input: { orderId: 'order-1' }, expected: 'The refund is recorded.' }],
  repeats: 2, timeoutMs: 1000, judge: 'rules', entry: 'eval.mjs',
};

async function fixture(t, overrides = {}) {
  const calls = [];
  const service = Object.fromEntries(['open', 'status', 'submitPlan', 'confirm', 'start', 'results', 'review', 'report', 'cancel', 'retryGrading', 'close'].map(method => [method, async args => {
    calls.push({ method, args });
    return { sessionId, method, busy: ['start', 'review', 'retryGrading'].includes(method) };
  }]));
  let disposals = 0;
  service.dispose = async () => { disposals++; };
  Object.assign(service, overrides);
  const server = createMcpServer({ service });
  const client = new Client({ name: 'evalpi-mcp-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, server, calls, disposals: () => disposals };
}

test('MCP advertises all evaluation tools and forwards valid arguments through the protocol', async t => {
  const { client, calls } = await fixture(t);
  const listing = await client.listTools();
  assert.equal(listing.tools.length, 11);
  assert.ok(listing.tools.every(tool => tool.inputSchema.additionalProperties === false));
  assert.match(listing.tools.find(tool => tool.name === 'evalpi_confirm').description, /user.*authorized/i);
  const samples = [
    ['open', 'open', { projectPath: '/projects/customer-service' }],
    ['status', 'status', { sessionId }],
    ['submit_plan', 'submitPlan', { sessionId, plan }],
    ['confirm', 'confirm', { sessionId, planId }],
    ['start', 'start', { sessionId, planId }],
    ['results', 'results', { sessionId, runId, offset: 0, limit: 5 }],
    ['review', 'review', { sessionId, runId, decisions: { refund_1: 'issue', refund_2: 'clear', refund_3: 'recheck' } }],
    ['report', 'report', { sessionId, runId }],
    ['cancel', 'cancel', { sessionId }],
    ['retry_grading', 'retryGrading', { sessionId, runId }],
    ['close', 'close', { sessionId }],
  ];
  for (const [name, method, args] of samples) {
    const result = await client.callTool({ name: `evalpi_${name}`, arguments: args });
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.method, method);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  }
  assert.deepEqual(calls, samples.map(([, method, args]) => ({ method, args })));
});

test('MCP rejects missing, unknown, malformed and nested invalid arguments before invoking the service', async t => {
  const { client, calls } = await fixture(t);
  const invalid = [
    ['open', {}], ['open', { projectPath: ' ' }],
    ['status', { sessionId: '../another-session' }], ['status', { sessionId, extra: true }],
    ['confirm', { sessionId }], ['start', { sessionId, planId: '' }],
    ['results', { sessionId, runId, limit: 21 }], ['results', { sessionId, runId, offset: -1 }],
    ['review', { sessionId, decisions: { refund_1: 'issue' } }],
    ['review', { sessionId, runId, decisions: { refund_1: 'pass' } }],
    ['review', { sessionId, runId, decisions: { '../other': 'issue' } }],
    ['report', { sessionId }], ['retry_grading', { sessionId }],
    ['submit_plan', { sessionId, plan: { ...plan, confirmed: true } }],
    ['submit_plan', { sessionId, plan: { ...plan, repeats: '2' } }],
    ['submit_plan', { sessionId, plan: { ...plan, cases: [{ ...plan.cases[0], script: 'arbitrary code' }] } }],
  ];
  for (const [name, args] of invalid) {
    const result = await client.callTool({ name: `evalpi_${name}`, arguments: args });
    assert.equal(result.isError, true, name);
    assert.match(result.content[0].text, /Invalid tool arguments/);
  }
  const unknown = await client.callTool({ name: 'evalpi_shell', arguments: {} });
  assert.equal(unknown.isError, true);
  assert.deepEqual(calls, []);
});

test('MCP surfaces service failures as tool errors without credential-like strings', async t => {
  const { client } = await fixture(t, { start: async () => { throw new Error('Failure: Bearer test-token api_key=secret-value sk-private-key'); } });
  const result = await client.callTool({ name: 'evalpi_start', arguments: { sessionId, planId } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Failure/);
  assert.doesNotMatch(result.content[0].text, /test-token|secret-value|sk-private-key/);
});

test('MCP report returns local resource links plus structured file metadata', async t => {
  const files = [{ name: 'report.pdf', path: '/reports/report.pdf', mimeType: 'application/pdf', uri: 'file:///reports/report.pdf' }];
  const { client } = await fixture(t, { report: async () => ({ sessionId, runId, files }) });
  const result = await client.callTool({ name: 'evalpi_report', arguments: { sessionId, runId } });
  assert.deepEqual(result.structuredContent.files, files);
  assert.deepEqual(result.content[1], { type: 'resource_link', name: 'report.pdf', uri: 'file:///reports/report.pdf', mimeType: 'application/pdf' });
});

test('MCP bounds unexpectedly large output and marks omitted evidence explicitly', async t => {
  const { client } = await fixture(t, { results: async () => ({ sessionId, runId, trials: Array.from({ length: 300 }, (_, id) => ({ id, output: 'x'.repeat(100_000) })) }) });
  const result = await client.callTool({ name: 'evalpi_results', arguments: { sessionId, runId } });
  assert.equal(result.structuredContent.truncated, true);
  assert.match(result.structuredContent.notice, /appendices/);
  assert.ok(result.content[0].text.length < 60_000);
});

test('MCP closing either side disposes the service once and waits for cleanup', async t => {
  const { client, server, disposals } = await fixture(t);
  await client.close();
  await server.close();
  await server.close();
  assert.equal(disposals(), 1);
});

test('MCP server.close awaits asynchronous service disposal', async t => {
  let finish, entered, disposed = false, closed = false;
  const begun = new Promise(resolve => { entered = resolve; });
  const cleanup = new Promise(resolve => { finish = resolve; });
  const { server } = await fixture(t, { dispose: async () => { entered(); await cleanup; disposed = true; } });
  const closing = server.close().then(() => { closed = true; });
  await begun;
  assert.equal(closed, false);
  finish();
  await closing;
  assert.equal(disposed, true);
  assert.equal(closed, true);
});

test('real stdio entry initializes and lists tools with isolated empty data directories', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'evalpi-mcp-protocol-'));
  const client = new Client({ name: 'evalpi-stdio-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(appRoot, 'server', 'mcp.mjs')], cwd: appRoot, stderr: 'pipe',
    env: { EVALPI_PLUGIN_DATA_DIR: path.join(directory, 'plugin'), EVALPI_MODEL_DATA_DIR: path.join(directory, 'models'), PROMPTFOO_DISABLE_TELEMETRY: '1' },
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += String(chunk).slice(0, 2000); });
  t.after(async () => { await client.close(); await rm(directory, { recursive: true, force: true }); });
  await client.connect(transport, { timeout: 20_000 });
  const result = await client.listTools();
  assert.equal(result.tools.length, 11);
  assert.equal(client.getServerVersion().name, 'evalpi');
  const opened = await client.callTool({ name: 'evalpi_open', arguments: { projectPath: path.join(appRoot, 'examples', 'customer-service') } });
  assert.notEqual(opened.isError, true, JSON.stringify(opened));
  assert.equal(opened.structuredContent.plan.confirmed, false);
  assert.equal(opened.structuredContent.model.authenticated, false);
  const lock = path.join(directory, 'plugin', 'sessions', opened.structuredContent.sessionId, '.plugin-lock');
  await access(lock);
  await client.close();
  await assert.rejects(access(lock), error => error.code === 'ENOENT');
  assert.doesNotMatch(stderr, /could not start|shutdown failed/);
});
