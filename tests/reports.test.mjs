import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createReport } from '../server/reports.mjs';

async function reportFixture(t, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'evalpi-report-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const trial = { id: 'trial-1', caseId: 'CS-014', trial: 1, status: 'completed', verdict: 'fail', reason: '工具超时后声称提交成功', durationMs: 25, sessionId: 'session-1', judgeSource: 'llm', output: { reply: '已提交', observedState: { tickets: [] } }, trace: [] };
  const project = { name: '客服测试', path: directory };
  const plan = { id: 'plan-1', goal: '确认真实提交', cases: [{ id: 'CS-014', name: '超时', expected: '不声称成功' }], criteria: ['如实说明工具结果'], repeats: 1, judge: 'llm', source: 'fixture' };
  const run = { id: 'run-test', planId: plan.id, status: 'completed', planned: 1, reviews: {}, rechecks: [], trials: [trial], judge: { provider: 'openai', model: 'test-judge', authMode: 'subscription' }, ...overrides };
  const generate = async (nextRun = run, nextPlan = plan) => {
    const report = await createReport({ project, plan: nextPlan, run: nextRun, directory, assetsRoot: directory });
    return { html: await readFile(path.join(directory, report.filename), 'utf8'), csv: await readFile(path.join(directory, report.filename.replace('-report.html', '-results.csv')), 'utf8') };
  };
  return { project, trial, run, plan, generate };
}

test('hard-rule failure with judge failure reports both evidence and scoring anomaly', async t => {
  const { trial, run, generate } = await reportFixture(t);
  trial.ruleResult = { verdict: 'fail', reason: '后台没有工单' };
  trial.grading = { status: 'error', reason: '连接中断', durationMs: 800, errorCode: 'NETWORK' };
  const { html, csv } = await generate();
  assert.match(html, /执行或评分异常<strong>1<\/strong>/);
  assert.match(html, /原始模型评分已完成 0 次，失败 1 次/);
  assert.match(html, /本轮评分模型：test-judge · openai/);
  assert.match(html, /规则失败结论保留/);
  assert.match(html, /仍有 1 次评分未完成/);
  assert.match(csv, /"fail","后台没有工单","openai","test-judge","error"/);
  assert.equal(run.trials[0].verdict, 'fail');
});

test('failed judge retry remains outstanding and successful retry remains a separate record', async t => {
  const { trial, run, generate } = await reportFixture(t);
  trial.grading = { status: 'error', reason: '连接中断' };
  run.rechecks.push({ trialId: trial.id, caseId: trial.caseId, source: 'judge-retry', gradingStatus: 'error', verdict: 'pending', reason: '仍然连接失败', checkedAt: '2026-10-02T08:00:00.000Z' });
  const failed = await generate();
  assert.match(failed.html, /重试 1 次，已补齐 0 次/);
  assert.match(failed.html, /仍有 1 次评分未完成/);
  run.rechecks.push({ trialId: trial.id, caseId: trial.caseId, source: 'judge-retry', gradingStatus: 'completed', verdict: 'fail', reason: '工具没有成功提交', judge: run.judge, checkedAt: '2026-10-02T08:01:00.000Z' });
  const completed = await generate();
  assert.match(completed.html, /原始模型评分已完成 0 次，失败 1 次/);
  assert.match(completed.html, /重试 2 次，已补齐 1 次/);
  assert.doesNotMatch(completed.html, /仍有 1 次评分未完成/);
  assert.match(completed.html, /最近评分重试 · 发现问题 · test-judge/);
  assert.equal(trial.grading.status, 'error');
});

test('rule-only baseline does not claim model grading even when rule grading is completed', async t => {
  const { trial, run, plan, generate } = await reportFixture(t, { judge: undefined });
  trial.judgeSource = 'rules';
  trial.grading = { status: 'completed', verdict: 'fail', reason: '业务状态不符合标准', durationMs: 2 };
  trial.ruleResult = { verdict: 'fail', reason: '后台没有工单' };
  const { html } = await generate(run, { ...plan, judge: 'rules' });
  assert.doesNotMatch(html, /本轮评分模型：/);
  assert.doesNotMatch(html, /原始模型评分：/);
  assert.match(html, /本批未调用模型评分/);
});

test('agent-generated plan retains fixture target disclosure', async t => {
  const { project, run, plan, generate } = await reportFixture(t);
  project.manifest = { kind: 'deterministic-fixture' };
  const { html } = await generate(run, { ...plan, source: 'agent' });
  assert.match(html, /实际执行记录 · 本地测试项目/);
  assert.match(html, /本轮被测对象为内置的确定性客服测试程序/);
  assert.match(html, /不能代表真实大模型质量/);
});

test('tool result text preserves FAQ evidence, escapes markup and remains bounded beside legacy status', async t => {
  const { trial, generate } = await reportFixture(t);
  trial.trace = [
    { type: 'tool_result', name: 'faq_lookup', turn: 1, result: `FAQ 中没有匹配答案。<script>alert("faq")</script>${'长'.repeat(260)}SHOULD_BE_CLIPPED` },
    { type: 'tool_result', name: 'submit_after_sales', turn: 2, status: 'ok', committed: true, ticketId: 'T1' },
  ];
  const { html } = await generate();
  assert.match(html, /第 1 轮<\/span><span>工具返回：FAQ 中没有匹配答案。&lt;script&gt;alert\(&quot;faq&quot;\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>|SHOULD_BE_CLIPPED/);
  assert.match(html, /第 2 轮 · 状态 ok · 已提交 · 记录 T1/);
});

test('target provenance stays escaped plain text, separates different records and states missing coverage', async t => {
  const { trial, run, generate } = await reportFixture(t);
  const target = { repository: 'https://example.com/customer-service', commit: 'abc123', sdkVersion: '0.18.0', provider: 'openai', model: 'target-a', businessEnvironment: 'Upstream mock FAQ and seat-update context; no real airline service.' };
  trial.output.target = target;
  run.trials.push({ ...trial, id: 'trial-2', output: { ...trial.output, target: { ...target, model: 'target-b<script>unsafe</script>' } } }, { ...trial, id: 'trial-3', output: { reply: '无来源记录' } });
  run.planned = 3;
  const { html } = await generate();
  const source = html.match(/<div class="target-source">[\s\S]*?<\/div>/)?.[0];
  assert.ok(source);
  assert.match(source, /来源由被测项目适配器记录，覆盖 2\/3 次执行/);
  assert.match(source, /本批包含 2 组不同来源记录/);
  assert.match(source, /其余执行未提供来源信息/);
  assert.match(source, /被测模型：target-a/);
  assert.match(source, /被测模型：target-b&lt;script&gt;unsafe&lt;\/script&gt;/);
  assert.match(source, /仓库：https:\/\/example.com\/customer-service；Commit：abc123；SDK：0.18.0；供应商：openai/);
  assert.match(source, /上游示例的模拟业务环境/);
  assert.doesNotMatch(source, /<a\b|<script>|test-judge/);
});

test('absent target provenance does not infer target model from the judge', async t => {
  const { generate } = await reportFixture(t);
  const { html } = await generate();
  assert.doesNotMatch(html, /<div class="target-source">/);
  assert.match(html, /本轮评分模型：test-judge · openai/);
});
