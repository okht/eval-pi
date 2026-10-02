import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../server/runtime.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceProject = path.join(appRoot, 'examples', 'customer-service');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, { runner, authenticated = false, modelOverrides = {} } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'evalpi-runtime-test-'));
  const dataDir = path.join(directory, 'app-data');
  const projectDir = path.join(directory, 'project');
  await cp(sourceProject, projectDir, { recursive: true });
  const calls = { run: 0, judged: [], authUpdate: null, nextPlan: null };
  const modelsFactory = async ({ onAuthUpdate }) => {
    calls.authUpdate = onAuthUpdate;
    return {
      status: async () => ({ provider: 'openai', model: 'test-model', authenticated, authMode: authenticated ? 'api-key' : 'none', availableModels: ['test-model'] }),
      configure: async () => {}, login: async () => {}, cancelLogin() {}, submitLoginCode() {}, dispose: async () => {},
      judge: async args => { calls.judged.push(args); return { verdict: 'fail', reason: '独立复核发现问题' }; },
      chat: async ({ onPlan }) => { if (calls.nextPlan) await onPlan(calls.nextPlan); return '测试方案已更新。'; },
      ...modelOverrides,
    };
  };
  const options = { dataDir, appRoot, modelsFactory };
  if (runner) options.runner = async args => { calls.run++; return runner(args); };
  const runtime = await createRuntime(options);
  t.after(() => runtime.dispose());
  return { runtime, dataDir, projectDir, directory, calls, modelsFactory };
}

async function syntheticRun({ project, plan, directory, onTrial }) {
  const run = { id: 'test-run', planId: plan.id, projectPath: project.path, directory, status: 'running', startedAt: new Date().toISOString(), planned: plan.cases.length * plan.repeats, trials: [], reviews: {} };
  for (const evalCase of plan.cases) for (let attempt = 1; attempt <= plan.repeats; attempt++) {
    const trial = { id: `${evalCase.id}-${attempt}`, caseId: evalCase.id, trial: attempt, status: 'completed', output: { reply: '合成输出', trace: [] }, trace: [], verdict: 'fail', reason: '原始机器判定', durationMs: 10, sessionId: `${evalCase.id}-session-${attempt}`, judgeSource: plan.judge };
    run.trials.push(trial);
    await onTrial?.(trial, run);
  }
  run.status = 'completed'; run.finishedAt = new Date().toISOString();
  await writeFile(path.join(directory, 'run.json'), JSON.stringify(run));
  return run;
}

async function prepare(runtime, projectDir) {
  await runtime.selectProject(projectDir);
  const plan = runtime.snapshot().plan;
  await runtime.confirm(plan.id);
  return plan;
}

test('execution cannot start before the exact current plan is confirmed', async t => {
  const { runtime, projectDir, calls } = await fixture(t, { runner: syntheticRun });
  await runtime.selectProject(projectDir);
  const plan = runtime.snapshot().plan;
  assert.equal(plan.confirmed, false);
  await assert.rejects(runtime.start(plan.id), /确认/);
  await assert.rejects(runtime.confirm('stale-plan-id'), /方案已经变化/);
  assert.equal(calls.run, 0);
  assert.equal(runtime.snapshot().run, null);
});

test('concurrent start requests reserve the workspace before asynchronous validation', async t => {
  const entered = deferred(), release = deferred();
  const { runtime, projectDir, calls } = await fixture(t, { runner: async args => { entered.resolve(); await release.promise; return syntheticRun(args); } });
  const plan = await prepare(runtime, projectDir);
  await runtime.start(plan.id);
  try {
    await assert.rejects(runtime.start(plan.id), /仍在进行|仍在运行/);
    await entered.promise;
    assert.equal(calls.run, 1);
    assert.equal(runtime.snapshot().busy, true);
  } finally { release.resolve(); }
  await runtime.idle();
  assert.equal(runtime.snapshot().run.status, 'completed');
  assert.equal(calls.run, 1);
});

test('confirmation reserves the workspace until its project revision is saved', async t => {
  const { runtime, projectDir } = await fixture(t, { runner: syntheticRun });
  await runtime.selectProject(projectDir);
  const plan = runtime.snapshot().plan;
  const confirmation = runtime.confirm(plan.id);
  try {
    assert.equal(runtime.snapshot().busy, true, 'confirmation must reserve before its first filesystem await');
    await assert.rejects(runtime.selectProject(projectDir), /仍在进行|仍在运行/);
  } finally { await confirmation; }
  assert.equal(runtime.snapshot().plan.id, plan.id);
  assert.equal(runtime.snapshot().plan.confirmed, true);
});

test('project switches discard previous confirmation and completed run ownership', async t => {
  const { runtime, projectDir, directory, calls } = await fixture(t, { runner: syntheticRun });
  const first = await prepare(runtime, projectDir);
  await runtime.start(first.id); await runtime.idle();
  const otherProject = path.join(directory, 'other-project');
  await cp(sourceProject, otherProject, { recursive: true });
  await runtime.selectProject(otherProject);
  const current = runtime.snapshot();
  assert.equal(current.plan.confirmed, false);
  assert.notEqual(current.plan.id, first.id);
  assert.equal(current.run, null);
  await assert.rejects(runtime.start(first.id), /确认/);
  await assert.rejects(runtime.start(current.plan.id), /确认/);
  assert.equal(calls.run, 1);
});

test('a revised agent plan resets approval even when the model supplies confirmed true', async t => {
  const { runtime, projectDir, calls } = await fixture(t, { runner: syntheticRun, authenticated: true });
  const first = await prepare(runtime, projectDir);
  calls.nextPlan = { ...runtime.snapshot().plan, title: '新的范围', confirmed: true, repeats: 1 };
  await runtime.message('调整评测方案'); await runtime.idle();
  const revised = runtime.snapshot().plan;
  assert.notEqual(revised.id, first.id);
  assert.equal(revised.confirmed, false);
  await assert.rejects(runtime.start(revised.id), /确认/);
  assert.equal(calls.run, 0);
});

test('runtime accepts a two-minute target plan and preserves it when a later deadline exceeds the limit', async t => {
  const { runtime, projectDir, calls } = await fixture(t, { runner: syntheticRun, authenticated: true });
  await runtime.selectProject(projectDir);
  calls.nextPlan = { ...runtime.snapshot().plan, timeoutMs: 120000, repeats: 1 };
  await runtime.message('将单次目标超时改成两分钟'); await runtime.idle();
  const accepted = runtime.snapshot().plan;
  assert.equal(accepted.timeoutMs, 120000);
  assert.equal(accepted.confirmed, false);
  await runtime.confirm(accepted.id);
  await runtime.start(accepted.id); await runtime.idle();
  assert.equal(calls.run, 1);
  assert.equal(runtime.snapshot().run.status, 'completed');
  calls.nextPlan = { ...accepted, timeoutMs: 180001 };
  await runtime.message('超出单次目标时限'); await runtime.idle();
  assert.match(runtime.snapshot().error, /超时/);
  assert.equal(runtime.snapshot().plan.id, accepted.id);
  assert.equal(runtime.snapshot().plan.timeoutMs, 120000);
  assert.equal(calls.run, 1);
});

test('source or manifest edits after confirmation prevent execution under stale approval', async t => {
  const { runtime, projectDir, calls } = await fixture(t, { runner: syntheticRun });
  let plan = await prepare(runtime, projectDir);
  const entry = path.join(projectDir, plan.entry);
  await writeFile(entry, (await readFile(entry, 'utf8')) + '\n// changed after confirmation\n');
  await runtime.start(plan.id); await runtime.idle();
  assert.match(runtime.snapshot().error, /已经变化/);
  assert.equal(calls.run, 0);
  plan = await prepare(runtime, projectDir);
  const manifestPath = path.join(projectDir, 'evalpi.json');
  const manifest = await json(manifestPath);
  manifest.goal = '确认后更换了目标';
  await writeFile(manifestPath, JSON.stringify(manifest));
  await runtime.start(plan.id); await runtime.idle();
  assert.match(runtime.snapshot().error, /已经变化/);
  assert.equal(calls.run, 0);
});

test('explicit human decisions and original verdicts survive rechecks and later batches', async t => {
  const { runtime, projectDir, calls } = await fixture(t, { runner: syntheticRun, authenticated: true });
  await runtime.selectProject(projectDir);
  calls.nextPlan = { ...runtime.snapshot().plan, judge: 'llm', repeats: 1 };
  await runtime.message('改为模型评审'); await runtime.idle();
  const plan = runtime.snapshot().plan;
  await runtime.confirm(plan.id); await runtime.start(plan.id); await runtime.idle();
  await runtime.review({ 'CS-001': 'clear', 'CS-014': 'issue' }); await runtime.idle();
  let run = runtime.snapshot().run;
  assert.equal(run.reviews['CS-001'], 'clear');
  assert.equal(run.reviews['CS-014'], 'issue');
  assert.equal(run.reviews['CS-027'], 'recheck');
  assert.ok(run.trials.every(trial => trial.verdict === 'fail' && trial.reason === '原始机器判定'));
  assert.equal(calls.judged.length, 0, 'objective rule failures must remain a hard gate without a model override');
  assert.deepEqual(run.rechecks.map(record => record.caseId).sort(), ['CS-027', 'CS-042']);
  assert.ok(run.rechecks.every(record => record.verdict === 'fail' && record.checkedAt));
  await runtime.review({ 'CS-027': 'clear', 'CS-042': 'issue' }); await runtime.idle();
  run = runtime.snapshot().run;
  assert.deepEqual(run.reviews, { 'CS-001': 'clear', 'CS-014': 'issue', 'CS-027': 'clear', 'CS-042': 'issue' });
  assert.equal(calls.judged.length, 0);
  assert.deepEqual((await json(path.join(run.directory, 'run.json'))).reviews, run.reviews);
  assert.ok((await readdir(run.directory)).some(name => /^recheck-.*\.json$/.test(name)));
});

test('recheck uses the independent LLM for evidence without declared objective checks', async t => {
  const { runtime, projectDir, calls } = await fixture(t, { authenticated: true, runner: args => syntheticRun({ ...args, onTrial: async (trial, run) => {
    trial.output = { reply: '已提交', replies: ['请提供订单号', '已提交'], observedState: { tickets: [{ orderId: 'A100' }] } };
    trial.trace = [{ type: 'harness_state_snapshot', state: trial.output.observedState }];
    await args.onTrial(trial, run);
  } }) });
  const manifestPath = path.join(projectDir, 'evalpi.json');
  const manifest = await json(manifestPath);
  for (const evalCase of manifest.cases) if (['CS-027', 'CS-042'].includes(evalCase.id)) evalCase.checks = [];
  await writeFile(manifestPath, JSON.stringify(manifest));
  await runtime.selectProject(projectDir);
  calls.nextPlan = { ...runtime.snapshot().plan, judge: 'llm', repeats: 1 };
  await runtime.message('改为模型评审'); await runtime.idle();
  const plan = runtime.snapshot().plan;
  await runtime.confirm(plan.id); await runtime.start(plan.id); await runtime.idle();
  await runtime.review({ 'CS-001': 'clear', 'CS-014': 'issue' }); await runtime.idle();
  assert.deepEqual(calls.judged.map(args => args.case.id).sort(), ['CS-027', 'CS-042']);
  assert.ok(calls.judged.every(args => args.criteria.length === plan.criteria.length && args.output.observedState.tickets.length === 1));
  const run = runtime.snapshot().run;
  assert.equal(run.reviews['CS-001'], 'clear');
  assert.equal(run.reviews['CS-014'], 'issue');
  assert.equal(run.rechecks.length, 2);
  assert.ok(run.rechecks.every(record => record.reason === '独立复核发现问题'));
});

test('pending OAuth locks model selection and execution until authorization settles', async t => {
  const authorization = deferred();
  const { runtime, projectDir } = await fixture(t, { runner: syntheticRun, modelOverrides: {
    login: async ({ onUrl }) => { onUrl('https://auth.openai.com/test-authorization'); await authorization.promise; },
    cancelLogin: () => authorization.resolve(),
  } });
  const plan = await prepare(runtime, projectDir);
  const login = await runtime.login();
  assert.equal(login.url, 'https://auth.openai.com/test-authorization');
  try {
    for (const operation of [
      () => runtime.configure({ provider: 'openai', model: 'changed' }),
      () => runtime.selectProject(projectDir),
      () => runtime.start(plan.id),
      () => runtime.message('在登录期间发送消息'),
      () => runtime.confirm(plan.id),
    ]) await assert.rejects(operation(), /登录|授权|运行/);
  } finally { authorization.resolve(); await runtime.dispose(); }
});

test('restart marks an unfinished batch interrupted and retains its evidence', async t => {
  const { runtime, projectDir, dataDir, modelsFactory } = await fixture(t, { runner: syntheticRun });
  const plan = await prepare(runtime, projectDir);
  await runtime.start(plan.id); await runtime.idle();
  const savedFile = path.join(dataDir, 'workspace.json');
  const saved = await json(savedFile);
  saved.run.status = 'running'; saved.run.trials = saved.run.trials.slice(0, 2); saved.busy = true;
  await writeFile(path.join(saved.run.directory, 'run.json'), JSON.stringify(saved.run));
  await writeFile(savedFile, JSON.stringify(saved));
  const restored = await createRuntime({ dataDir, appRoot, modelsFactory });
  try {
    const state = restored.snapshot();
    assert.equal(state.run.status, 'interrupted');
    assert.equal(state.busy, false);
    assert.equal(state.run.trials.length, 2);
    assert.deepEqual(state.run.trials, saved.run.trials);
    assert.match(state.error, /上次运行意外中断/);
    assert.equal((await json(savedFile)).run.status, 'interrupted');
  } finally { await restored.dispose(); }
});

test('report JSON is an immutable snapshot including plan, actual trials and human decisions', async t => {
  const { runtime, projectDir, dataDir } = await fixture(t, { runner: syntheticRun });
  const plan = await prepare(runtime, projectDir);
  await runtime.start(plan.id); await runtime.idle();
  const decisions = Object.fromEntries(plan.cases.map(evalCase => [evalCase.id, 'issue']));
  await runtime.review(decisions); await runtime.idle();
  const before = runtime.snapshot();
  const report = await runtime.report();
  assert.match(report.url, /^\/api\/files\/.*-report\.html$/);
  const name = report.filename.replace(/-report\.html$/, '-snapshot.json');
  const snapshotFile = path.join(dataDir, 'reports', name);
  const originalBytes = await readFile(snapshotFile, 'utf8');
  const captured = JSON.parse(originalBytes);
  assert.deepEqual(captured.project, before.project);
  assert.deepEqual(captured.plan, before.plan);
  assert.deepEqual(captured.run, before.run);
  await runtime.review({ 'CS-001': 'clear' }); await runtime.idle();
  assert.equal(runtime.snapshot().run.reviews['CS-001'], 'clear');
  assert.equal(await readFile(snapshotFile, 'utf8'), originalBytes);
  assert.equal(captured.run.reviews['CS-001'], 'issue');
});

test('model auth callbacks update public status and accept an error message string', async t => {
  const { runtime, calls } = await fixture(t, { runner: syntheticRun });
  const status = { provider: 'openai', model: 'test-model', authenticated: true, authMode: 'subscription', availableModels: ['test-model'] };
  await calls.authUpdate(status, '测试登录提示');
  assert.deepEqual(runtime.snapshot().model, status);
  assert.equal(runtime.snapshot().error, '测试登录提示');
});

test('real fixture completes through runtime, process runner and business-state checks', async t => {
  const { runtime, projectDir } = await fixture(t);
  const plan = await prepare(runtime, projectDir);
  await runtime.start(plan.id); await runtime.idle();
  const state = runtime.snapshot();
  assert.equal(state.error, null);
  assert.equal(state.run?.status, 'completed');
  assert.equal(state.run.trials.length, 12);
  assert.equal(state.run.trials.filter(trial => trial.verdict === 'pass').length, 6);
  assert.equal(state.run.trials.filter(trial => trial.verdict === 'fail').length, 6);
  assert.equal(new Set(state.run.trials.map(trial => trial.sessionId)).size, 12);
  assert.ok(state.run.trials.every(trial => trial.output?.observedState));
  assert.equal((await json(path.join(state.run.directory, 'plan.json'))).id, plan.id);
});

async function prepareIncompleteScoring(t, modelOverrides = {}) {
  const setup = await fixture(t, { authenticated: true, modelOverrides, runner: args => syntheticRun({ ...args, onTrial: async (trial, run) => {
    run.judge = args.judgeInfo;
    trial.output = { reply: '已经提交', observedState: { tickets: [] } };
    trial.judgeSource = 'llm';
    trial.grading = { status: trial.caseId === 'CS-014' ? 'error' : 'completed', durationMs: 5 };
    trial.ruleResult = { verdict: 'fail', reason: '后台未提交却声称已成功' };
    await args.onTrial(trial, run);
  } }) });
  await setup.runtime.selectProject(setup.projectDir);
  setup.calls.nextPlan = { ...setup.runtime.snapshot().plan, judge: 'llm', repeats: 1 };
  await setup.runtime.message('使用模型评分'); await setup.runtime.idle();
  const plan = setup.runtime.snapshot().plan;
  await setup.runtime.confirm(plan.id); await setup.runtime.start(plan.id); await setup.runtime.idle();
  return setup;
}

test('retry grading uses saved evidence once, preserves raw trials and human decisions', async t => {
  const { runtime, calls } = await prepareIncompleteScoring(t);
  await runtime.review(Object.fromEntries(runtime.snapshot().plan.cases.map(c => [c.id, 'issue']))); await runtime.idle();
  const before = runtime.snapshot().run;
  await assert.rejects(runtime.retryGrading('stale-run'), /当前没有/);
  await runtime.retryGrading(before.id); await runtime.idle();
  const after = runtime.snapshot().run;
  assert.equal(calls.run, 1, 'retry must not invoke the target runner again');
  assert.equal(calls.judged.length, 1);
  assert.equal(calls.judged[0].case.id, 'CS-014');
  assert.deepEqual(after.trials, before.trials);
  assert.deepEqual(after.reviews, before.reviews);
  assert.equal(after.rechecks.at(-1).source, 'judge-retry');
  assert.equal(after.rechecks.at(-1).gradingStatus, 'completed');
  assert.equal(after.rechecks.at(-1).verdict, 'fail');
  await assert.rejects(runtime.retryGrading(before.id), /没有未完成/);
});

test('failed grading retry stays retryable and cannot overrule an objective failure', async t => {
  let attempts = 0;
  const { runtime, calls } = await prepareIncompleteScoring(t, { judge: async () => {
    if (++attempts === 1) throw new Error('private-provider-error');
    return { verdict: 'pass', reason: '模型认为成功' };
  } });
  const runId = runtime.snapshot().run.id;
  await runtime.retryGrading(runId); await runtime.idle();
  let check = runtime.snapshot().run.rechecks.at(-1);
  assert.equal(check.gradingStatus, 'error');
  assert.equal(check.verdict, 'pending');
  assert.doesNotMatch(check.reason, /private-provider-error/);
  await runtime.message('重试未完成评分'); await runtime.idle();
  check = runtime.snapshot().run.rechecks.at(-1);
  assert.equal(check.gradingStatus, 'completed');
  assert.equal(check.verdict, 'fail');
  assert.equal(attempts, 2); assert.equal(calls.run, 1);
});

test('retry refuses a changed scoring model before consuming any model request', async t => {
  let selected = 'test-model';
  let judged = 0;
  const { runtime } = await prepareIncompleteScoring(t, {
    status: async () => ({ provider: 'openai', model: selected, authMode: 'subscription', authenticated: true, availableModels: [selected] }),
    judge: async () => { judged++; return { verdict: 'pass', reason: '通过' }; },
  });
  selected = 'another-model';
  await runtime.retryGrading(runtime.snapshot().run.id); await runtime.idle();
  assert.equal(judged, 0);
  assert.match(runtime.snapshot().error, /原评分模型/);
});

test('recovery loads target evidence newer than workspace snapshot and makes grading retryable', async t => {
  const { runtime, dataDir, modelsFactory } = await prepareIncompleteScoring(t);
  const before = runtime.snapshot();
  const durable = structuredClone(before.run);
  durable.status = 'running';
  const trial = durable.trials.find(t => t.caseId === 'CS-014');
  trial.grading = { status: 'not_run' };
  const saved = await json(path.join(dataDir, 'workspace.json'));
  saved.run.status = 'running'; saved.run.trials = []; saved.busy = true;
  await writeFile(path.join(dataDir, 'workspace.json'), JSON.stringify(saved));
  await writeFile(path.join(durable.directory, 'run.json'), JSON.stringify(durable));
  const restored = await createRuntime({ dataDir, appRoot, modelsFactory });
  try {
    const recovered = restored.snapshot().run;
    assert.equal(recovered.status, 'interrupted');
    assert.equal(recovered.trials.length, durable.trials.length);
    assert.equal(recovered.trials.find(t => t.id === trial.id).grading.status, 'cancelled');
    assert.equal(recovered.trials.find(t => t.id === trial.id).verdict, 'fail');
    await restored.retryGrading(recovered.id); await restored.idle();
    assert.equal(restored.snapshot().run.rechecks.at(-1).gradingStatus, 'completed');
  } finally { await restored.dispose(); }
});

test('completed-run recovery retains durable review and retry records newer than workspace', async t => {
  const { runtime, dataDir, modelsFactory, calls } = await prepareIncompleteScoring(t);
  const durable = structuredClone(runtime.snapshot().run);
  durable.reviews['CS-014'] = 'issue';
  durable.rechecks = [{ trialId: 'CS-014-1', caseId: 'CS-014', source: 'judge-retry', gradingStatus: 'completed', verdict: 'fail', reason: '已完成评分', checkedAt: new Date().toISOString() }];
  await writeFile(path.join(durable.directory, 'run.json'), JSON.stringify(durable));
  const restored = await createRuntime({ dataDir, appRoot, modelsFactory });
  try {
    assert.equal(restored.snapshot().run.reviews['CS-014'], 'issue');
    assert.equal(restored.snapshot().run.rechecks.length, 1);
    assert.equal(restored.snapshot().run.status, 'completed');
    await assert.rejects(restored.retryGrading(durable.id), /没有未完成/);
    assert.equal(calls.judged.length, 0);
  } finally { await restored.dispose(); }
});
