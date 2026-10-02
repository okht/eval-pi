import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, cp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPluginService } from '../server/plugin-service.mjs';
import { createRuntime } from '../server/runtime.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectPath = path.join(appRoot, 'examples', 'customer-service');
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const modelsFactory = async () => ({
  status: async () => ({ provider: 'test', model: 'no-network', authenticated: false, authMode: 'none' }),
  cancelLogin() {}, dispose: async () => {},
  judge: async () => { throw new Error('This test must not call a model.'); },
});

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'evalpi-plugin-'));
  const create = () => createPluginService({ appRoot, dataDir: directory, runtimeFactory: options => createRuntime({ ...options, modelsFactory }), ...overrides });
  const service = await create();
  t.after(() => service.dispose());
  return { service, directory, create };
}

async function idle(service, sessionId) {
  for (let i = 0; i < 400; i++) {
    const state = await service.status({ sessionId });
    if (!state.busy) return state;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Evaluation did not finish in time.');
}

test('plugin runs the real fixture through confirmation, repeated execution, batch review and immutable report artifacts', async t => {
  const { service } = await fixture(t);
  const opened = await service.open({ projectPath });
  const sessionId = opened.sessionId;
  assert.equal(opened.plan.confirmed, false);
  assert.equal(opened.plan.caseCount, 4);
  assert.equal(opened.model.authenticated, false);
  const plan = await readJson(opened.files.plan);
  assert.equal(plan.cases.length, 4);
  await assert.rejects(service.start({ sessionId, planId: plan.id }), /确认/);
  await service.confirm({ sessionId, planId: plan.id });
  await service.start({ sessionId, planId: plan.id });
  const state = await idle(service, sessionId);
  assert.equal(state.error, null);
  assert.equal(state.run.status, 'completed');
  assert.equal(state.run.recorded, 12);
  assert.deepEqual(state.run.originalVerdicts, { pass: 6, fail: 6, pending: 0, error: 0 });
  const runId = state.run.id;
  const raw = await readJson(state.files.evidence);
  assert.equal(new Set(raw.trials.map(trial => trial.sessionId)).size, 12);
  const page = await service.results({ sessionId, runId, limit: 2 });
  assert.equal(page.trials.length, 2);
  assert.equal(page.nextOffset, 2);
  assert.equal(page.total, 12);
  await assert.rejects(service.review({ sessionId, runId: 'old-run', decisions: { 'CS-014': 'clear' } }), /Run changed/);
  await service.review({ sessionId, runId, decisions: { 'CS-014': 'issue', 'CS-001': 'clear' } });
  const reviewed = await idle(service, sessionId);
  assert.equal(reviewed.run.reviews['CS-014'], 'issue');
  assert.equal(reviewed.run.reviews['CS-001'], 'clear');
  assert.equal(reviewed.run.reviews['CS-027'], 'recheck');
  assert.equal(reviewed.run.recheckCount, 6);
  assert.deepEqual(reviewed.run.originalVerdicts, state.run.originalVerdicts);
  const report = await service.report({ sessionId, runId });
  assert.equal(report.files.length, 4);
  for (const file of report.files) {
    assert.equal(path.isAbsolute(file.path), true);
    assert.equal(fileURLToPath(file.uri), file.path);
    assert.ok((await readFile(file.path)).length > 0);
  }
  const snapshot = report.files.find(file => file.name.endsWith('-snapshot.json'));
  const before = await readFile(snapshot.path, 'utf8');
  await service.review({ sessionId, runId, decisions: { 'CS-014': 'clear' } });
  await idle(service, sessionId);
  assert.equal(await readFile(snapshot.path, 'utf8'), before);
  const html = await readFile(report.files.find(file => file.mimeType === 'text/html').path, 'utf8');
  for (const file of report.files.filter(file => file.mimeType !== 'text/html')) assert.ok(html.includes(file.name));
});

test('same-project sessions are isolated and only a closed session can be resumed by another host', async t => {
  const { service, create } = await fixture(t);
  const one = await service.open({ projectPath });
  const two = await service.open({ projectPath });
  assert.notEqual(one.sessionId, two.sessionId);
  assert.notEqual(one.files.workspace, two.files.workspace);
  await service.confirm({ sessionId: one.sessionId, planId: one.plan.id });
  assert.equal((await service.status({ sessionId: two.sessionId })).plan.confirmed, false);
  const other = await create();
  t.after(() => other.dispose());
  await assert.rejects(other.status({ sessionId: one.sessionId }), /locked/);
  await service.close({ sessionId: one.sessionId });
  const restored = await other.status({ sessionId: one.sessionId });
  assert.equal(restored.plan.id, one.plan.id);
  assert.equal(restored.plan.confirmed, true);
  await assert.rejects(other.status({ sessionId: '../models' }), /Invalid evaluation session/);
  await assert.rejects(other.open({ projectPath: 'relative/path' }), /absolute/);
});

test('direct plan submission does not invoke a planner and old confirmation cannot execute the replacement', async t => {
  const { service } = await fixture(t);
  const opened = await service.open({ projectPath });
  await service.confirm({ sessionId: opened.sessionId, planId: opened.plan.id });
  const candidate = await readJson(opened.files.plan);
  candidate.repeats = 1;
  const updated = await service.submitPlan({ sessionId: opened.sessionId, plan: candidate });
  assert.notEqual(updated.plan.id, opened.plan.id);
  assert.equal(updated.plan.confirmed, false);
  assert.equal(updated.plan.plannedTrials, 4);
  assert.equal((await readJson(updated.files.plan)).confirmed, false);
  await assert.rejects(service.start({ sessionId: opened.sessionId, planId: opened.plan.id }), /确认/);
});

test('interrupted host shutdown cancels an active target and preserves resumable evidence', async t => {
  const { service, directory, create } = await fixture(t);
  const slowProject = path.join(directory, 'slow-project');
  await cp(projectPath, slowProject, { recursive: true });
  await writeFile(path.join(slowProject, 'workflow.mjs'), 'setInterval(() => {}, 1000);');
  const opened = await service.open({ projectPath: slowProject });
  await service.confirm({ sessionId: opened.sessionId, planId: opened.plan.id });
  await service.start({ sessionId: opened.sessionId, planId: opened.plan.id });
  for (let i = 0; i < 100; i++) {
    if ((await service.status({ sessionId: opened.sessionId })).run) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await service.dispose();
  const other = await create();
  t.after(() => other.dispose());
  const restored = await other.status({ sessionId: opened.sessionId });
  assert.equal(restored.busy, false);
  assert.ok(restored.run);
  assert.notEqual(restored.run.status, 'running');
  assert.ok(await readJson(restored.files.evidence));
});

test('concurrent session and host shutdown dispose once and cannot remove a later lock', async t => {
  let disposals = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const { service, create } = await fixture(t, { runtimeFactory: async options => {
    const runtime = await createRuntime({ ...options, modelsFactory });
    const dispose = runtime.dispose.bind(runtime);
    runtime.dispose = async () => { disposals++; await gate; await dispose(); };
    return runtime;
  } });
  const opened = await service.open({ projectPath });
  const first = service.close({ sessionId: opened.sessionId });
  const second = service.close({ sessionId: opened.sessionId });
  const shutdown = service.dispose();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(disposals, 1);
  release();
  await Promise.all([first, second, shutdown]);
  const other = await create();
  t.after(() => other.dispose());
  assert.equal((await other.status({ sessionId: opened.sessionId })).plan.id, opened.plan.id);
});

test('restoring copied run ownership cannot redirect writes to another session', async t => {
  const { service } = await fixture(t);
  const one = await service.open({ projectPath });
  const two = await service.open({ projectPath });
  await service.confirm({ sessionId: one.sessionId, planId: one.plan.id });
  await service.start({ sessionId: one.sessionId, planId: one.plan.id });
  const finished = await idle(service, one.sessionId);
  const original = await readFile(finished.files.evidence, 'utf8');
  await service.close({ sessionId: two.sessionId });
  const saved = await readJson(two.files.workspace);
  saved.run = { ...await readJson(finished.files.evidence), planId: saved.plan.id };
  await writeFile(two.files.workspace, JSON.stringify(saved));
  await assert.rejects(service.status({ sessionId: two.sessionId }), /outside this evaluation session/);
  assert.equal(await readFile(finished.files.evidence, 'utf8'), original);
});
