import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { computeJudgeMetrics } from '../server/judge-benchmark.mjs';
import { buildReviewQueue, createJudgeBenchmarkReport } from '../server/judge-benchmark-report.mjs';

const makeCase = (id, split = 'contract') => ({ id, source: split === 'contract' ? 'contract-probes' : 'ragtruth-qa', split,
  labelOrigin: split === 'contract' ? 'constructed' : 'human', referenceVerdict: 'pass', reference: { humanReviewed: false },
  request: { case: { id, name: 'Evidence check', input: {}, expected: 'A supported answer' }, criteria: ['Evidence is required'], output: { answer: '<script>LEAK()</script>' }, trace: [] },
});

test('unfinished cases and absent repeats remain visible in review queue and CSV', async () => {
  const cases = [makeCase('partial'), makeCase('untouched')];
  const trials = [{ caseId: 'partial', trial: 1, status: 'completed', verdict: 'pass', reason: 'supported' }];
  const review = buildReviewQueue(cases, trials, 2);
  assert.deepEqual(review.map(item => [item.caseId, item.missingTrials]), [['partial', [2]], ['untouched', [1, 2]]]);
  const directory = await mkdtemp(path.join(tmpdir(), 'evalpi-benchmark-report-'));
  const run = { id: 'partial-run', status: 'cancelled', repeats: 2, planned: 4, trials, summary: computeJudgeMetrics(cases, trials, { repeats: 2 }) };
  await createJudgeBenchmarkReport({ run, cases, manifest: {}, directory });
  const csv = await readFile(path.join(directory, 'results.csv'), 'utf8');
  assert.equal(csv.split('\r\n').length, 5);
  assert.equal((csv.match(/"not_run"/g) ?? []).length, 3);
  const html = await readFile(path.join(directory, 'judge-report.html'), 'utf8');
  assert.ok(html.includes('本批未完成'));
  assert.ok(!html.includes('保留集已有案例被本次验收读取'));
  assert.ok(!html.includes('公开人工标签基准初验'));
  assert.ok(!html.includes('https://github.com/ParticleMedia/RAGTruth'));
  assert.ok(html.includes('不估计（构造对照）'));
});

test('untrusted replies and Judge rationale cannot become executable HTML in report', async () => {
  const cases = [makeCase('case-one', 'heldout')];
  const trials = [{ caseId: 'case-one', trial: 1, status: 'completed', verdict: 'fail', reason: '<img src=x onerror=LEAK()> unsupported' }];
  const directory = await mkdtemp(path.join(tmpdir(), 'evalpi-benchmark-html-'));
  const run = { id: 'completed-run', status: 'completed', repeats: 1, planned: 1, trials, summary: computeJudgeMetrics(cases, trials, { repeats: 1 }) };
  await createJudgeBenchmarkReport({ run, cases, manifest: {}, directory });
  const html = await readFile(path.join(directory, 'judge-report.html'), 'utf8');
  assert.ok(html.includes('&lt;script&gt;LEAK()&lt;/script&gt;'));
  assert.ok(html.includes('&lt;img src=x onerror=LEAK()&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('本次未包含构造案例'));
  assert.ok(html.includes('保留集已有案例被本次验收读取'));
});
