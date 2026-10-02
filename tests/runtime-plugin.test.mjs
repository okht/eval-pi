import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../server/runtime.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceProject = path.join(appRoot, 'examples', 'customer-service');
const json = async filename => JSON.parse(await readFile(filename, 'utf8'));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function completedRun({ project, plan, directory, onTrial }) {
  const trial = { id: 'trial-1', caseId: plan.cases[0].id, trial: 1, status: 'completed', output: { reply: 'Synthetic output' }, trace: [], verdict: 'fail', reason: 'Original finding', sessionId: 'synthetic-session', durationMs: 1 };
  const run = { id: path.basename(directory), planId: plan.id, projectPath: project.path, directory, status: 'completed', planned: plan.cases.length * plan.repeats, trials: [trial], reviews: {}, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
  await onTrial(trial, run);
  await writeFile(path.join(directory, 'run.json'), JSON.stringify(run));
  return run;
}

async function fixture(t, { runner = completedRun, modelsDataDir } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'evalpi-plugin-runtime-test-'));
  const projectDir = path.join(directory, 'project');
  const dataDir = path.join(directory, 'session');
  await cp(sourceProject, projectDir, { recursive: true });
  const calls = { runs: 0, chats: 0, modelDirectories: [] };
  const modelsFactory = async options => {
    calls.modelDirectories.push(options.dataDir);
    return {
      status: async () => ({ provider: 'test', model: 'test-model', authenticated: false, authMode: 'none', availableModels: [] }),
      cancelLogin() {}, dispose: async () => {},
      chat: async () => { calls.chats++; throw new Error('The host must supply the plan without invoking a planner model.'); },
    };
  };
  const runtime = await createRuntime({ dataDir, appRoot, modelsDataDir, modelsFactory, runner: async args => { calls.runs++; return runner(args); } });
  t.after(() => runtime.dispose());
  return { runtime, directory, dataDir, projectDir, calls, modelsFactory };
}

test('direct plan submission needs a selected project and never invokes a planner model', async t => {
  const { runtime, projectDir, calls } = await fixture(t);
  await assert.rejects(runtime.submitPlan({}), /选择项目/);
  await runtime.selectProject(projectDir);
  const draft = { ...runtime.snapshot().plan, title: 'Host-authored plan', confirmed: true, id: 'caller-supplied-id' };
  const submitted = await runtime.submitPlan(draft);
  assert.equal(submitted.busy, false);
  assert.equal(submitted.plan.title, draft.title);
  assert.equal(submitted.plan.confirmed, false);
  assert.notEqual(submitted.plan.id, draft.id);
  assert.equal(calls.chats, 0);
  draft.cases[0].input.changed = true;
  submitted.plan.criteria.push('External mutation');
  assert.equal(runtime.snapshot().plan.cases[0].input.changed, undefined);
  assert.ok(!runtime.snapshot().plan.criteria.includes('External mutation'));
});

test('replacing a confirmed plan clears previous run ownership and persists a fresh approval requirement', async t => {
  const { runtime, projectDir, dataDir, calls } = await fixture(t);
  await runtime.selectProject(projectDir);
  const original = runtime.snapshot().plan;
  await runtime.confirm(original.id);
  await runtime.start(original.id); await runtime.idle();
  assert.equal(calls.runs, 1);
  const oldRunId = runtime.snapshot().run.id;
  const submitted = await runtime.submitPlan({ ...original, confirmed: true, title: 'Revised scope' });
  assert.equal(submitted.run, null);
  assert.equal(submitted.plan.confirmed, false);
  assert.notEqual(submitted.plan.id, original.id);
  const saved = await json(path.join(dataDir, 'workspace.json'));
  assert.equal(saved.revision, null);
  assert.equal(saved.run, null);
  assert.deepEqual(saved.plan, submitted.plan);
  await assert.rejects(runtime.start(original.id), /确认/);
  await assert.rejects(runtime.start(submitted.plan.id), /确认/);
  await assert.rejects(runtime.confirm(original.id), /方案已经变化/);
  await assert.rejects(runtime.review({ [original.cases[0].id]: 'clear' }, oldRunId), /没有可复核/);
  assert.equal(calls.runs, 1);
  await runtime.confirm(submitted.plan.id);
  await runtime.start(submitted.plan.id); await runtime.idle();
  assert.equal(calls.runs, 2);
  assert.equal(runtime.snapshot().run.planId, submitted.plan.id);
});

test('invalid plans and entries preserve the approved plan and its evidence', async t => {
  const { runtime, projectDir, directory, dataDir } = await fixture(t);
  await runtime.selectProject(projectDir);
  const plan = runtime.snapshot().plan;
  await runtime.confirm(plan.id);
  await runtime.start(plan.id); await runtime.idle();
  const before = runtime.snapshot();
  const saved = await json(path.join(dataDir, 'workspace.json'));
  await writeFile(path.join(directory, 'outside.mjs'), 'export default {};');
  for (const candidate of [
    { ...plan, repeats: 11 },
    { ...plan, cases: [] },
    { ...plan, entry: '../outside.mjs' },
  ]) await assert.rejects(runtime.submitPlan(candidate));
  const after = runtime.snapshot();
  assert.deepEqual(after.plan, before.plan);
  assert.deepEqual(after.run, before.run);
  assert.equal(after.busy, false);
  assert.equal((await json(path.join(dataDir, 'workspace.json'))).revision, saved.revision);
});

test('submission reserves the session before file validation and rejects concurrent mutations', async t => {
  const { runtime, projectDir } = await fixture(t);
  await runtime.selectProject(projectDir);
  const candidate = runtime.snapshot().plan;
  const pending = runtime.submitPlan(candidate);
  assert.equal(runtime.snapshot().busy, true);
  await assert.rejects(runtime.submitPlan(candidate), /仍在进行/);
  await assert.rejects(runtime.selectProject(projectDir), /仍在进行/);
  const submitted = await pending;
  assert.equal(submitted.busy, false);
  assert.equal(runtime.snapshot().plan.id, submitted.plan.id);
});

test('an active evaluation prevents replacing its plan or starting review', async t => {
  const entered = deferred(), release = deferred();
  const { runtime, projectDir } = await fixture(t, { runner: async args => { entered.resolve(); await release.promise; return completedRun(args); } });
  await runtime.selectProject(projectDir);
  const plan = runtime.snapshot().plan;
  await runtime.confirm(plan.id);
  await runtime.start(plan.id);
  try {
    await entered.promise;
    await assert.rejects(runtime.submitPlan({ ...plan, title: 'Concurrent change' }), /仍在进行/);
    await assert.rejects(runtime.review({}), /仍在进行/);
    assert.equal(runtime.snapshot().plan.id, plan.id);
  } finally { release.resolve(); }
  await runtime.idle();
  assert.equal(runtime.snapshot().run.planId, plan.id);
});

test('separate sessions can explicitly reuse the existing model directory without sharing plans or runs', async t => {
  const sharedModelsDir = path.join(os.tmpdir(), 'evalpi-explicit-model-location');
  const { runtime, dataDir, directory, projectDir, calls, modelsFactory } = await fixture(t, { modelsDataDir: sharedModelsDir });
  const otherDataDir = path.join(directory, 'other-session');
  const other = await createRuntime({ dataDir: otherDataDir, appRoot, modelsDataDir: sharedModelsDir, modelsFactory });
  t.after(() => other.dispose());
  await runtime.selectProject(projectDir);
  const plan = runtime.snapshot().plan;
  await runtime.confirm(plan.id);
  await runtime.start(plan.id); await runtime.idle();
  assert.deepEqual(calls.modelDirectories, [sharedModelsDir, sharedModelsDir]);
  assert.equal(other.snapshot().project, null);
  assert.equal(other.snapshot().plan, null);
  assert.equal(other.snapshot().run, null);
  assert.equal((await json(path.join(otherDataDir, 'workspace.json'))).plan, null);
  assert.equal((await json(path.join(dataDir, 'workspace.json'))).run.planId, plan.id);
});

test('model directory defaults remain compatible with the desktop runtime', async t => {
  const { calls, dataDir } = await fixture(t);
  assert.deepEqual(calls.modelDirectories, [path.join(dataDir, 'models')]);
});

test('batch review rejects an old run id even when case ids are reused', async t => {
  const { runtime, projectDir } = await fixture(t);
  await runtime.selectProject(projectDir);
  const plan = runtime.snapshot().plan;
  await runtime.confirm(plan.id);
  await runtime.start(plan.id); await runtime.idle();
  const oldRun = runtime.snapshot().run;
  await runtime.start(plan.id); await runtime.idle();
  const currentRun = runtime.snapshot().run;
  assert.notEqual(currentRun.id, oldRun.id);
  await assert.rejects(runtime.review({ [plan.cases[0].id]: 'clear' }, oldRun.id), /批次已经变化/);
  assert.deepEqual(runtime.snapshot().run.reviews, {});
  const decisions = { [plan.cases[0].id]: 'issue' };
  await runtime.review(decisions, currentRun.id);
  decisions[plan.cases[0].id] = 'clear';
  await runtime.idle();
  assert.equal(runtime.snapshot().run.reviews[plan.cases[0].id], 'issue');
  assert.deepEqual(runtime.snapshot().run.trials, currentRun.trials);
});
