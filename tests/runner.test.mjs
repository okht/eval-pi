import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { inspectProject, createFixturePlan, resolveProjectFile } from '../server/project.mjs';
import { runEvaluation, scoreRules } from '../server/runner.mjs';

const fixturePath = fileURLToPath(new URL('../examples/customer-service', import.meta.url));

async function workspace(t) {
  const root = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(root, 'evalpi-test-'));
  t.after(async () => {
    const relative = path.relative(root, path.resolve(directory));
    assert.ok(relative.startsWith('evalpi-test-') && !relative.includes(path.sep));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function customProject(t, script, options = {}) {
  const directory = await workspace(t);
  const root = path.join(directory, 'project');
  await mkdir(root);
  await writeFile(path.join(root, 'entry.mjs'), script, 'utf8');
  const manifest = {
    version: 1, name: 'runner test', kind: 'node-workflow', entry: 'entry.mjs', repeats: 1, timeoutMs: 1500,
    cases: [{ id: 'one', name: 'one', input: {}, expected: 'value must be 1', checks: [{ path: 'value', op: 'equals', value: 1 }] }],
    ...options,
  };
  await writeFile(path.join(root, 'evalpi.json'), JSON.stringify(manifest));
  const project = await inspectProject(root);
  const plan = { ...createFixturePlan(project), confirmed: true };
  return { project, plan, directory: path.join(directory, 'results') };
}

test('Promptfoo repeats execute independent processes and collect real business-state snapshots', async (t) => {
  const directory = await workspace(t);
  const project = await inspectProject(fixturePath);
  const plan = { ...createFixturePlan(project), confirmed: true };
  const received = [];
  const run = await runEvaluation({ project, plan, directory, onTrial: (trial) => received.push(trial.id) });
  assert.equal(run.status, 'completed');
  assert.equal(run.planned, 12);
  assert.equal(run.trials.length, 12);
  assert.equal(run.trials.filter((trial) => trial.verdict === 'pass').length, 6);
  assert.equal(run.trials.filter((trial) => trial.verdict === 'fail').length, 6);
  assert.equal(new Set(run.trials.map((trial) => trial.sessionId)).size, 12);
  assert.equal(new Set(run.trials.map((trial) => trial.id)).size, 12);
  assert.deepEqual(received, run.trials.map((trial) => trial.id));
  for (const trial of run.trials) {
    assert.equal(trial.output.initialTicketCount, 0);
    assert.equal(trial.output.sessionId, trial.sessionId);
    assert.equal(trial.output.observedState.sessionId, trial.sessionId);
    assert.ok(trial.trace.some((event) => event.type === 'harness_state_snapshot'));
  }
  const saved = JSON.parse(await readFile(path.join(directory, 'run.json'), 'utf8'));
  assert.deepEqual(saved, run);
  assert.equal((await readFile(path.join(directory, 'trials.jsonl'), 'utf8')).trim().split('\n').length, 12);
  assert.equal((await readFile(path.join(directory, 'executions.jsonl'), 'utf8')).trim().split('\n').length, 12);
  assert.ok(!project.files.includes('.env'));
});

test('manifest and runner allow multi-turn target deadlines up to 180 seconds', async (t) => {
  const args = await customProject(t, 'process.stdout.write(JSON.stringify({ value: 1 }))', { timeoutMs: 120000 });
  assert.equal(args.plan.timeoutMs, 120000);
  const run = await runEvaluation(args);
  assert.equal(run.trials[0].verdict, 'pass');
  await assert.rejects(runEvaluation({ ...args, plan: { ...args.plan, timeoutMs: 180001 } }), /单次超时/);
  const manifest = { ...args.project.manifest, timeoutMs: 180000 };
  await writeFile(path.join(args.project.path, 'evalpi.json'), JSON.stringify(manifest));
  assert.equal(createFixturePlan(await inspectProject(args.project.path)).timeoutMs, 180000);
  manifest.timeoutMs = 180001;
  await writeFile(path.join(args.project.path, 'evalpi.json'), JSON.stringify(manifest));
  await assert.rejects(inspectProject(args.project.path), /timeoutMs/);
  delete manifest.timeoutMs;
  await writeFile(path.join(args.project.path, 'evalpi.json'), JSON.stringify(manifest));
  assert.equal(createFixturePlan(await inspectProject(args.project.path)).timeoutMs, 5000);
});

test('target timeouts are execution errors, remaining repeats still run, no score is invented', async (t) => {
  const args = await customProject(t, 'setInterval(() => {}, 1000)', { repeats: 2, timeoutMs: 100 });
  const run = await runEvaluation(args);
  assert.equal(run.status, 'completed');
  assert.equal(run.trials.length, 2);
  for (const trial of run.trials) {
    assert.equal(trial.status, 'error');
    assert.equal(trial.verdict, 'error');
    assert.equal(trial.judgeSource, 'none');
    assert.equal(trial.grading.status, 'not_run');
    assert.equal(trial.trace[0].code, 'TARGET_TIMEOUT');
  }
});

test('cancellation kills the active process and does not start queued repeats', async (t) => {
  const args = await customProject(t, 'setInterval(() => {}, 1000)', { repeats: 3, timeoutMs: 5000 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 200);
  t.after(() => clearTimeout(timer));
  const run = await runEvaluation({ ...args, signal: controller.signal });
  assert.equal(run.status, 'cancelled');
  assert.equal(run.trials.length, 1);
  assert.equal(run.trials[0].status, 'cancelled');
  assert.equal(run.trials[0].trace[0].code, 'ABORT_ERR');
});

test('already cancelled runs never execute targets', async (t) => {
  const args = await customProject(t, 'process.stdout.write(JSON.stringify({ value: 1 }))');
  const controller = new AbortController();
  controller.abort();
  const run = await runEvaluation({ ...args, signal: controller.signal });
  assert.equal(run.status, 'cancelled');
  assert.equal(run.trials.length, 0);
});

test('onStart receives a durable zero-trial run before execution and can cancel it', async (t) => {
  const args = await customProject(t, 'throw new Error("must not execute")');
  const controller = new AbortController();
  let published;
  const run = await runEvaluation({ ...args, signal: controller.signal, onStart: async (initial) => {
    published = structuredClone(initial);
    assert.equal(initial.status, 'running');
    assert.equal(initial.trials.length, 0);
    assert.deepEqual(JSON.parse(await readFile(path.join(args.directory, 'run.json'), 'utf8')), initial);
    controller.abort();
  } });
  assert.equal(published.id, run.id);
  assert.equal(run.status, 'cancelled');
  assert.equal(run.trials.length, 0);
  assert.equal(JSON.parse(await readFile(path.join(args.directory, 'run.json'), 'utf8')).status, 'cancelled');
});

test('onStart persistence errors stop a batch before execution and retain its durable record', async (t) => {
  const args = await customProject(t, 'throw new Error("must not execute")');
  const run = await runEvaluation({ ...args, onStart: async () => { throw new Error('workspace persistence unavailable'); } });
  assert.equal(run.status, 'failed');
  assert.equal(run.trials.length, 0);
  const error = JSON.parse(await readFile(path.join(args.directory, 'run-error.json'), 'utf8'));
  assert.equal(error.message, 'workspace persistence unavailable');
});

test('entry fingerprint changes stop remaining trials and preserve already completed evidence', async (t) => {
  const source = 'process.stdout.write(JSON.stringify({ value: 1 }))';
  const args = await customProject(t, source, { repeats: 3 });
  const run = await runEvaluation({ ...args, onTrial: async (trial) => {
    if (trial.trial === 1) await writeFile(path.join(args.project.path, 'entry.mjs'), 'process.stdout.write(JSON.stringify({ value: 999 }))');
  } });
  assert.equal(run.status, 'failed');
  assert.equal(run.planned, 3);
  assert.equal(run.trials.length, 2);
  assert.equal(run.trials[0].verdict, 'pass');
  assert.equal(run.trials[0].output.value, 1);
  assert.equal(run.trials[1].status, 'error');
  assert.equal(run.trials[1].output, undefined);
  assert.equal(run.trials[1].trace[0].code, 'ENTRY_CHANGED');
  const metadata = JSON.parse(await readFile(path.join(args.directory, 'execution.json'), 'utf8'));
  assert.equal(metadata.entrySha256, createHash('sha256').update(source).digest('hex'));
  assert.equal(metadata.hashScope, 'entry-file-only');
  const saved = JSON.parse(await readFile(path.join(args.directory, 'run.json'), 'utf8'));
  assert.deepEqual(saved, run);
  assert.equal(JSON.parse(await readFile(path.join(args.directory, 'run-error.json'), 'utf8')).code, 'ENTRY_CHANGED');
});

test('entry changed in onStart cannot be executed even for the first trial', async (t) => {
  const args = await customProject(t, 'process.stdout.write(JSON.stringify({ value: 1 }))');
  const run = await runEvaluation({ ...args, onStart: async () => {
    await writeFile(path.join(args.project.path, 'entry.mjs'), 'throw new Error("changed code must never execute")');
  } });
  assert.equal(run.status, 'failed');
  assert.equal(run.trials.length, 1);
  assert.equal(run.trials[0].trace[0].code, 'ENTRY_CHANGED');
  assert.equal(run.trials[0].output, undefined);
});

test('unsafe or unconfirmed plans are rejected before any target execution', async (t) => {
  const args = await customProject(t, 'throw new Error("must never run")');
  await assert.rejects(runEvaluation({ ...args, plan: { ...args.plan, confirmed: false } }), /确认/);
  await assert.rejects(runEvaluation({ ...args, plan: { ...args.plan, repeats: 11 } }), /重复/);
  await assert.rejects(runEvaluation({ ...args, plan: { ...args.plan, id: '../escape' } }), /id/);
  await assert.rejects(resolveProjectFile(args.project.path, '../entry.mjs'), /越过/);
  await assert.rejects(resolveProjectFile(args.project.path, process.execPath), /相对路径/);
  const changed = structuredClone(args.project);
  changed.manifest.entry = '../entry.mjs';
  await assert.rejects(runEvaluation({ ...args, project: changed, plan: { ...args.plan, entry: '../entry.mjs' } }), /越过/);
});

test('inspector skips secret files, dependency trees and symlinked directories', async (t) => {
  const args = await customProject(t, 'process.stdout.write("{}")');
  await writeFile(path.join(args.project.path, '.env'), 'OPENAI_API_KEY=DO_NOT_EXPOSE');
  await writeFile(path.join(args.project.path, 'credentials.json'), '{"apiKey":"DO_NOT_EXPOSE"}');
  await mkdir(path.join(args.project.path, 'node_modules'));
  await writeFile(path.join(args.project.path, 'node_modules', 'internal.md'), 'DO_NOT_EXPOSE');
  const outside = path.join(path.dirname(args.project.path), 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'outside.mjs'), 'DO_NOT_EXPOSE');
  await symlink(outside, path.join(args.project.path, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const inspected = await inspectProject(args.project.path);
  assert.equal(inspected.summary.includes('DO_NOT_EXPOSE'), false);
  assert.equal(inspected.files.some((file) => file.startsWith('linked') || file.startsWith('node_modules') || file.includes('credential') || file === '.env'), false);
  await assert.rejects(resolveProjectFile(args.project.path, 'linked/outside.mjs'), /符号链接/);
});

test('invalid JSON, nonzero exit and excessive output are execution errors', async (t) => {
  for (const [script, code] of [
    ['process.stdout.write("not json")', 'INVALID_OUTPUT'],
    ['process.stderr.write("tool crashed"); process.exit(7)', 'TARGET_EXIT'],
    ['process.stdout.write("x".repeat(2 * 1024 * 1024)); setInterval(() => {}, 1000)', 'OUTPUT_LIMIT'],
  ]) {
    const run = await runEvaluation(await customProject(t, script));
    assert.equal(run.trials[0].status, 'error');
    assert.equal(run.trials[0].verdict, 'error');
    assert.equal(run.trials[0].trace[0].code, code);
  }
});

test('judge failure keeps execution completed and stored output available for evidence-only recheck', async (t) => {
  const args = await customProject(t, 'process.stdout.write(JSON.stringify({ value: 1, trace: [{type:"tool_result", value:1}] }))');
  const run = await runEvaluation({ ...args, plan: { ...args.plan, judge: 'llm' }, judge: async () => { throw new Error('model offline'); } });
  const trial = run.trials[0];
  assert.equal(trial.status, 'completed');
  assert.equal(trial.verdict, 'pending');
  assert.equal(trial.output.value, 1);
  assert.equal(trial.ruleResult.verdict, 'pass');
  assert.equal(trial.grading.status, 'error');
  assert.equal(trial.grading.errorCode, 'JUDGE_ERROR');
  assert.equal(trial.error, undefined);
  assert.match(trial.reason, /评分未完成/);
  // Removing the target proves this recheck cannot execute it again.
  await rm(path.join(args.project.path, 'entry.mjs'));
  const rescored = scoreRules(args.project, args.plan.cases[0], trial.output);
  assert.equal(rescored.verdict, 'pass');
  assert.equal(JSON.parse(await readFile(path.join(args.directory, 'run.json'), 'utf8')).trials.length, 1);
});

test('cancelling a non-responsive judge preserves completed target evidence', async (t) => {
  const args = await customProject(t, 'process.stdout.write(JSON.stringify({ value: 1 }))');
  const controller = new AbortController();
  const run = await runEvaluation({ ...args, plan: { ...args.plan, judge: 'llm' }, signal: controller.signal, judge: async () => {
    controller.abort();
    return new Promise(() => {});
  } });
  assert.equal(run.status, 'cancelled');
  assert.equal(run.trials[0].status, 'completed');
  assert.equal(run.trials[0].verdict, 'pending');
  assert.equal(run.trials[0].output.value, 1);
  assert.equal(run.trials[0].grading.status, 'cancelled');
  assert.equal(run.trials[0].grading.errorCode, 'ABORT_ERR');
  assert.equal(run.trials[0].error, undefined);
});

test('completed execution is durable before judge starts and final records are written once', async (t) => {
  const args = await customProject(t, 'process.stdout.write(JSON.stringify({ value: 1, trace: [{type:"tool_result", value:1}] }))', { repeats: 2 });
  const events = [];
  let judged = 0;
  const judgeInfo = { provider: 'test-provider', model: 'test-model', authMode: 'subscription', apiKey: 'must-not-store' };
  const run = await runEvaluation({ ...args, plan: { ...args.plan, judge: 'llm' }, judgeInfo,
    onProgress: async (event, current) => {
      events.push(event);
      assert.equal(event.completed, judged);
      if (event.phase === 'grading') {
        assert.equal(current.trials.length, judged + 1);
        assert.equal(current.trials.at(-1).output.value, 1);
      }
    },
    judge: async () => {
      const saved = JSON.parse(await readFile(path.join(args.directory, 'run.json'), 'utf8'));
      const executions = (await readFile(path.join(args.directory, 'executions.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      const finalized = (await readFile(path.join(args.directory, 'trials.jsonl'), 'utf8')).trim().split('\n').filter(Boolean);
      assert.equal(saved.trials.length, judged + 1);
      assert.equal(executions.length, judged + 1);
      assert.equal(finalized.length, judged);
      assert.equal(saved.trials.at(-1).output.value, 1);
      assert.equal(saved.trials.at(-1).verdict, 'pending');
      assert.equal(saved.trials.at(-1).grading.status, 'not_run');
      assert.equal(executions.at(-1).trace[0].type, 'tool_result');
      judged++;
      return { verdict: 'pass', reason: 'verified' };
    },
  });
  assert.equal(run.status, 'completed');
  assert.deepEqual(run.judge, { provider: 'test-provider', model: 'test-model', authMode: 'subscription' });
  assert.deepEqual(events.map(({ phase, completed, total, caseId, trial }) => [phase, completed, total, caseId, trial]), [
    ['executing', 0, 2, 'one', 1], ['grading', 0, 2, 'one', 1],
    ['executing', 1, 2, 'one', 2], ['grading', 1, 2, 'one', 2],
  ]);
  const finalRecords = (await readFile(path.join(args.directory, 'trials.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(finalRecords.length, 2);
  assert.equal(new Set(finalRecords.map(({ id }) => id)).size, 2);
  assert.deepEqual(finalRecords, run.trials);
  assert.ok(run.trials.every((trial) => trial.grading.status === 'completed' && trial.grading.verdict === 'pass'));
  const executionRecords = (await readFile(path.join(args.directory, 'executions.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(executionRecords.every((trial) => trial.grading.status === 'not_run'));
});

test('judge errors and cancellation cannot erase an observed rule failure', async (t) => {
  for (const mode of ['error', 'cancel']) {
    const args = await customProject(t, 'process.stdout.write(JSON.stringify({ value: 2 }))', { repeats: 2 });
    const controller = new AbortController();
    const run = await runEvaluation({ ...args, plan: { ...args.plan, judge: 'llm' }, signal: controller.signal, judge: async () => {
      if (mode === 'cancel') {
        controller.abort();
        return new Promise(() => {});
      }
      throw Object.assign(new Error('judge unavailable'), { code: 'MODEL_OFFLINE' });
    } });
    assert.equal(run.status, mode === 'cancel' ? 'cancelled' : 'completed');
    assert.equal(run.trials.length, mode === 'cancel' ? 1 : 2);
    for (const trial of run.trials) {
      assert.equal(trial.status, 'completed');
      assert.equal(trial.output.value, 2);
      assert.equal(trial.ruleResult.verdict, 'fail');
      assert.equal(trial.verdict, 'fail');
      assert.match(trial.reason, /实际 2/);
      assert.equal(trial.grading.status, mode === 'cancel' ? 'cancelled' : 'error');
      assert.equal(trial.error, undefined);
      assert.equal(trial.trace.at(-1).type, 'grading_error');
    }
    const saved = JSON.parse(await readFile(path.join(args.directory, 'run.json'), 'utf8'));
    assert.deepEqual(saved.trials, run.trials);
    assert.equal((await readFile(path.join(args.directory, 'executions.jsonl'), 'utf8')).trim().split('\n').length, run.trials.length);
    assert.equal((await readFile(path.join(args.directory, 'trials.jsonl'), 'utf8')).trim().split('\n').length, run.trials.length);
  }
});

test('model opinion cannot override an observable rule violation', async (t) => {
  const args = await customProject(t, 'process.stdout.write(JSON.stringify({ value: 2 }))');
  const run = await runEvaluation({ ...args, plan: { ...args.plan, judge: 'llm' }, judge: async () => ({ verdict: 'pass', reason: 'looks fine' }) });
  assert.equal(run.trials[0].verdict, 'fail');
  assert.equal(run.trials[0].ruleResult.verdict, 'fail');
  assert.equal(run.trials[0].grading.verdict, 'pass');
  assert.match(run.trials[0].reason, /实际 2/);
});

test('missing declared business state stays pending even if target self-reports success', async (t) => {
  const args = await customProject(t, 'process.stdout.write(JSON.stringify({ value: 1, observedState: {tickets:[1]} }))', { stateFile: 'business-state.json' });
  let judgeCalls = 0;
  const run = await runEvaluation({ ...args, plan: { ...args.plan, judge: 'llm' }, judge: async () => { judgeCalls++; return { verdict: 'pass', reason: 'fine' }; } });
  assert.equal(run.trials[0].status, 'completed');
  assert.equal(run.trials[0].verdict, 'pending');
  assert.equal(run.trials[0].output.observedState, undefined);
  assert.equal(judgeCalls, 0);
  assert.match(run.trials[0].reason, /证据无法读取/);
});

test('target processes receive isolated homes without inherited credential environment variables', async (t) => {
  const sentinel = 'EVALPI_TEST_PRIVATE_SENTINEL';
  process.env[sentinel] = 'do-not-inherit';
  t.after(() => delete process.env[sentinel]);
  const args = await customProject(t, 'process.stdout.write(JSON.stringify({ value: 1, cwd: process.cwd(), home: process.env.HOME, key: process.env.EVALPI_TEST_PRIVATE_SENTINEL, pid: process.pid }))', { repeats: 2 });
  const run = await runEvaluation(args);
  assert.notEqual(run.trials[0].output.pid, run.trials[1].output.pid);
  assert.notEqual(run.trials[0].output.home, run.trials[1].output.home);
  for (const trial of run.trials) {
    assert.equal(trial.output.key, undefined);
    assert.equal(trial.output.home, trial.output.cwd);
    await assert.rejects(lstat(trial.output.cwd), { code: 'ENOENT' });
  }
});
