import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { computeJudgeMetrics, runJudgeBenchmark } from '../server/judge-benchmark.mjs';

function example(id, referenceVerdict = 'pass', options = {}) {
  return {
    id, source: 'public-fixture', split: 'heldout', labelOrigin: 'human', referenceVerdict,
    reference: { secretExplanation: `gold-label-secret-${id}` },
    request: { case: { id, name: `Case ${id}`, input: { question: 'What is shown?' }, expected: 'State only what the supplied evidence supports.' }, criteria: ['Ground claims in the evidence.'], output: { answer: 'A box.' }, trace: [] },
    ...options,
  };
}

function observation(caseId, trial, verdict, status = 'completed') {
  return { caseId, trial, verdict, status };
}

async function temporary(t) {
  const root = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(root, 'evalpi-judge-test-'));
  t.after(async () => {
    const relative = path.relative(root, path.resolve(directory));
    assert.ok(relative.startsWith('evalpi-judge-test-') && !relative.includes(path.sep));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function sequentialScheduler(config, options) {
  for (const entry of config.tests) {
    for (let repeatIndex = 0; repeatIndex < options.repeat; repeatIndex++) {
      if (options.abortSignal.aborted) return;
      await config.providers[0].callApi('', { vars: entry.vars, repeatIndex });
    }
  }
}

test('first-repeat metrics preserve all outcome denominators and sample-level Wilson intervals', () => {
  const cases = [example('a', 'pass'), example('b', 'pass'), example('c', 'fail'), example('d', 'fail'), example('e', 'fail'), example('f', 'pending', { source: 'contract', split: 'contract', labelOrigin: 'constructed' }), example('g', 'pass'), example('h', 'fail')];
  const first = [observation('a', 1, 'pass'), observation('b', 1, 'fail'), observation('c', 1, 'pass'), observation('d', 1, 'pending'), observation('e', 1, 'fail'), observation('f', 1, 'pending'), observation('g', 1, null, 'error')];
  const trials = [...first, ...first.filter((trial) => trial.caseId !== 'd').map((trial) => ({ ...trial, trial: 2 })), observation('h', 2, 'fail')];
  const summary = computeJudgeMetrics(cases, trials, { repeats: 2 });
  const metrics = summary.overall;
  assert.equal(metrics.primary.accuracy.numerator, 3);
  assert.equal(metrics.primary.accuracy.denominator, 8);
  assert.equal(metrics.primary.accuracy.rate, 3 / 8);
  assert.ok(metrics.primary.accuracy.wilson95.lower > 0.13 && metrics.primary.accuracy.wilson95.lower < 0.14);
  assert.ok(metrics.primary.accuracy.wilson95.upper > 0.69 && metrics.primary.accuracy.wilson95.upper < 0.70);
  assert.deepEqual(metrics.primary.confusionMatrix, {
    pass: { pass: 1, fail: 1, pending: 0, error: 1, not_run: 0 },
    fail: { pass: 1, fail: 1, pending: 1, error: 0, not_run: 1 },
    pending: { pass: 0, fail: 0, pending: 1, error: 0, not_run: 0 },
  });
  assert.equal(metrics.binaryDetection.n, 7);
  assert.equal(metrics.binaryDetection.coverage.rate, 4 / 7);
  assert.equal(metrics.binaryDetection.accuracy.rate, 2 / 7);
  assert.equal(metrics.binaryDetection.falsePositive.rate, 1 / 3);
  assert.equal(metrics.binaryDetection.falseNegative.rate, 1 / 4);
  assert.equal(metrics.binaryDetection.failAbstention.rate, 1 / 4);
  assert.equal(metrics.binaryDetection.error.rate, 1 / 7);
  assert.equal(metrics.repeatStability.eligible, 5);
  assert.equal(metrics.repeatStability.excluded, 3);
  assert.equal(metrics.repeatStability.agreement.rate, 1);
  assert.equal(summary.byLabelOrigin.human.primary.accuracy.rate, 2 / 7);
  assert.equal(summary.byLabelOrigin.constructed.primary.accuracy.rate, 1);
  assert.equal(summary.strata.length, 2);
});

test('missing repeats and failed calls cannot inflate repeat agreement', () => {
  const cases = [example('a'), example('b'), example('c'), example('d')];
  const summary = computeJudgeMetrics(cases, [observation('a', 1, 'pass'), observation('a', 2, 'fail'), observation('b', 1, 'pass'), observation('c', 1, 'pass'), observation('c', 2, null, 'cancelled'), observation('d', 1, 'pending'), observation('d', 2, 'pending')], { repeats: 2 });
  assert.equal(summary.overall.repeatStability.eligible, 2);
  assert.equal(summary.overall.repeatStability.excluded, 2);
  assert.equal(summary.overall.repeatStability.agreement.rate, 0.5);
  assert.equal(summary.overall.attempts.cancelled, 1);
  assert.equal(summary.overall.attempts.notRun, 1);
  assert.equal(computeJudgeMetrics([example('a')], [observation('a', 1, 'pass')], { repeats: 1 }).overall.repeatStability.agreement.rate, null);
});

test('gold labels stay outside scheduler and Judge, requests are copied and all evidence is durable', async (t) => {
  const parent = await temporary(t);
  const directory = path.join(parent, 'run');
  const cases = [example('one', 'fail')];
  cases[0].request.referenceVerdict = 'secret-do-not-send';
  cases[0].request.case.referenceVerdict = 'secret-do-not-send';
  const received = [];
  const judgeInfo = { provider: 'mock', model: 'test', promptSha256: 'frozen-prompt' };
  const run = await runJudgeBenchmark({ cases, directory, repeats: 2, judgeInfo,
    scheduler: async (config, options) => {
      assert.deepEqual(config.tests, [{ vars: { caseId: 'one' } }]);
      assert.equal(options.cache, false);
      await sequentialScheduler(config, options);
    },
    judge: async (request) => {
      received.push({ ...request, signal: undefined });
      assert.deepEqual(Object.keys(request).sort(), ['case', 'criteria', 'output', 'signal', 'trace']);
      assert.ok(!JSON.stringify(request).includes('gold-label-secret'));
      assert.ok(!JSON.stringify(request).includes('secret-do-not-send'));
      assert.equal(request.output.answer, 'A box.');
      request.output.answer = 'Changed during one invocation';
      return { verdict: 'fail', reason: 'The evidence does not support the answer.' };
    },
    onProgress: () => { throw new Error('observer failed'); },
  });
  assert.equal(run.status, 'completed');
  assert.equal(run.completed, 2);
  assert.equal(run.observerFailures, 4);
  assert.equal(cases[0].request.output.answer, 'A box.');
  assert.notEqual(received[0].case, received[1].case);
  assert.equal(run.summary.overall.primary.accuracy.denominator, 1);
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.budget.plannedCalls, 2);
  assert.deepEqual(manifest.judgeInfo, judgeInfo);
  assert.match(manifest.datasetSha256, /^[a-f0-9]{64}$/);
  assert.match(manifest.requests[0].requestSha256, /^[a-f0-9]{64}$/);
  assert.equal(run.trials[0].requestSha256, manifest.requests[0].requestSha256);
  assert.equal((await readFile(path.join(directory, 'trials.jsonl'), 'utf8')).trim().split('\n').length, 2);
  assert.equal((await readFile(path.join(directory, 'calls.jsonl'), 'utf8')).trim().split('\n').length, 2);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'run.json'), 'utf8')), run);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'summary.json'), 'utf8')), run.summary);
});

test('model errors and invalid outputs are separate outcomes, with raw exception messages redacted', async (t) => {
  const parent = await temporary(t);
  const run = await runJudgeBenchmark({ cases: [example('one'), example('two'), example('three')], directory: path.join(parent, 'run'), repeats: 1, scheduler: sequentialScheduler,
    judge: async (request) => {
      if (request.case.id === 'one') throw Object.assign(new Error('provider leaked api_key=super-secret'), { code: 'MODEL_AUTH_ERROR' });
      if (request.case.id === 'two') return { verdict: 'pass' };
      return { verdict: 'pending', reason: 'Evidence missing.' };
    },
  });
  assert.equal(run.status, 'completed');
  assert.equal(run.summary.overall.attempts.error, 2);
  assert.equal(run.summary.overall.primary.confusionMatrix.pass.error, 2);
  assert.equal(run.summary.overall.primary.confusionMatrix.pass.pending, 1);
  assert.equal(run.trials[0].verdict, null);
  assert.equal(run.trials[1].errorCode, 'JUDGE_INVALID_OUTPUT');
  assert.ok(!JSON.stringify(run).includes('super-secret'));
  assert.ok(!(await readFile(path.join(run.directory, 'trials.jsonl'), 'utf8')).includes('super-secret'));
});

test('cancellation preserves the active call and leaves queued cases uncalled', async (t) => {
  const parent = await temporary(t);
  const controller = new AbortController();
  let called = 0;
  const run = await runJudgeBenchmark({ cases: [example('one'), example('two')], directory: path.join(parent, 'run'), repeats: 2, signal: controller.signal, scheduler: sequentialScheduler,
    judge: async () => {
      called++;
      controller.abort();
      return new Promise(() => {});
    },
  });
  assert.equal(called, 1);
  assert.equal(run.status, 'cancelled');
  assert.equal(run.planned, 4);
  assert.equal(run.completed, 1);
  assert.equal(run.trials[0].status, 'cancelled');
  assert.equal(run.trials[0].verdict, null);
  assert.equal(run.summary.overall.primary.confusionMatrix.pass.error, 1);
  assert.equal(run.summary.overall.primary.confusionMatrix.pass.not_run, 1);
  assert.equal(run.summary.overall.attempts.notRun, 3);
  assert.equal(run.summary.overall.repeatStability.agreement.rate, null);
  assert.equal((await readFile(path.join(run.directory, 'trials.jsonl'), 'utf8')).trim().split('\n').length, 1);
});

test('pre-cancelled runs consume no calls and retain their planned budget', async (t) => {
  const parent = await temporary(t);
  const run = await runJudgeBenchmark({ cases: [example('one')], directory: path.join(parent, 'run'), signal: AbortSignal.abort(), scheduler: sequentialScheduler, judge: () => { throw new Error('must not call'); } });
  assert.equal(run.status, 'cancelled');
  assert.equal(run.started, 0);
  assert.equal(run.planned, 2);
  assert.equal(run.summary.overall.attempts.notRun, 2);
  assert.equal(run.summary.overall.primary.accuracy.rate, 0);
});

test('parallel completions serialize append-only evidence and snapshots', async (t) => {
  const parent = await temporary(t);
  const cases = Array.from({ length: 8 }, (_, index) => example(`case-${index}`));
  const run = await runJudgeBenchmark({ cases, directory: path.join(parent, 'run'), repeats: 2, concurrency: 4,
    scheduler: async (config, options) => {
      const calls = config.tests.flatMap((entry) => Array.from({ length: options.repeat }, (_, repeatIndex) => ({ vars: entry.vars, repeatIndex })));
      for (let index = 0; index < calls.length; index += options.maxConcurrency) await Promise.all(calls.slice(index, index + options.maxConcurrency).map((context) => config.providers[0].callApi('', context)));
    },
    judge: async () => ({ verdict: 'pass', reason: 'Supported.' }),
  });
  assert.equal(run.status, 'completed');
  assert.equal(run.started, 16);
  assert.equal(run.completed, 16);
  assert.equal(new Set(run.trials.map((trial) => trial.id)).size, 16);
  const rows = (await readFile(path.join(run.directory, 'trials.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(rows, run.trials);
  assert.deepEqual(JSON.parse(await readFile(path.join(run.directory, 'run.json'), 'utf8')), run);
});

test('existing directories cannot be overwritten and validation rejects excessive budgets', async (t) => {
  const parent = await temporary(t);
  const directory = path.join(parent, 'exists');
  await mkdir(directory);
  await writeFile(path.join(directory, 'run.json'), 'untouched');
  const args = { cases: [example('one')], directory, judge: async () => ({ verdict: 'pass', reason: 'ok' }), scheduler: sequentialScheduler };
  await assert.rejects(runJudgeBenchmark(args), /拒绝覆盖/);
  assert.equal(await readFile(path.join(directory, 'run.json'), 'utf8'), 'untouched');
  await assert.rejects(runJudgeBenchmark({ ...args, repeats: 6 }), /重复次数/);
  await assert.rejects(runJudgeBenchmark({ ...args, concurrency: 5 }), /并发数/);
  await assert.rejects(runJudgeBenchmark({ ...args, cases: Array.from({ length: 101 }, (_, index) => example(`c${index}`)) }), /1–100/);
  assert.throws(() => computeJudgeMetrics(args.cases, [observation('one', 1, 'pass'), observation('one', 1, 'fail')]), /重复/);
});

test('scheduler failure retains completed trials and cannot disclose raw provider credentials', async (t) => {
  const parent = await temporary(t);
  const run = await runJudgeBenchmark({ cases: [example('one'), example('two')], directory: path.join(parent, 'run'), repeats: 1, judge: async () => ({ verdict: 'pass', reason: 'supported' }),
    scheduler: async (config) => {
      await config.providers[0].callApi('', { vars: { caseId: 'one' }, repeatIndex: 0 });
      throw new Error('super-secret-token');
    },
  });
  assert.equal(run.status, 'failed');
  assert.equal(run.completed, 1);
  assert.equal(run.summary.overall.primary.accuracy.rate, 0.5);
  assert.equal(run.summary.overall.primary.missing, 1);
  assert.ok(!JSON.stringify(run).includes('super-secret-token'));
});

test('real Promptfoo schedules each repeat once through the supplied isolated Judge', async (t) => {
  const parent = await temporary(t);
  let calls = 0;
  const run = await runJudgeBenchmark({ cases: [example('one'), example('two', 'fail')], directory: path.join(parent, 'run'), repeats: 2, concurrency: 2,
    judge: async (request) => {
      calls++;
      return { verdict: request.case.id === 'one' ? 'pass' : 'fail', reason: 'Controlled test verdict.' };
    },
  });
  assert.equal(calls, 4);
  assert.equal(run.status, 'completed');
  assert.deepEqual(run.trials.map((trial) => `${trial.caseId}:${trial.trial}`).sort(), ['one:1', 'one:2', 'two:1', 'two:2']);
  assert.equal(run.summary.overall.primary.accuracy.rate, 1);
  assert.equal(run.summary.overall.primary.accuracy.denominator, 2);
  assert.equal(run.summary.overall.repeatStability.agreement.rate, 1);
  assert.equal(JSON.parse(await readFile(path.join(run.directory, 'manifest.json'), 'utf8')).scheduler, 'promptfoo');
});
