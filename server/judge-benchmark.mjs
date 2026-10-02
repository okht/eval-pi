import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const VERDICTS = ['pass', 'fail', 'pending'];
const OUTCOMES = [...VERDICTS, 'error', 'not_run'];
let promptfooPromise;

async function promptfoo() {
  process.env.PROMPTFOO_DISABLE_TELEMETRY = '1';
  process.env.PROMPTFOO_DISABLE_UPDATE = '1';
  process.env.PROMPTFOO_DISABLE_REMOTE_GENERATION = 'true';
  process.env.PROMPTFOO_CACHE_ENABLED = 'false';
  promptfooPromise ??= import('promptfoo');
  return promptfooPromise;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function hash(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

// A deliberate allowlist prevents benchmark metadata and reference labels from
// entering the scorer. The expected field describes the business requirement,
// never the reference verdict. Each invocation gets a fresh copy of this view.
function judgeRequest(entry) {
  const request = entry.request;
  return cloneJson({
    case: { id: request.case.id, name: request.case.name, input: request.case.input, expected: request.case.expected },
    criteria: request.criteria,
    output: request.output,
    trace: request.trace,
  });
}

function validateCases(cases) {
  if (!Array.isArray(cases) || cases.length < 1 || cases.length > 100) throw new Error('Judge 验收需要 1–100 条用例。');
  const ids = new Set();
  for (const entry of cases) {
    if (!entry || typeof entry.id !== 'string' || !/^[\w-]{1,100}$/.test(entry.id) || ids.has(entry.id)) throw new Error('Judge 验收用例 id 无效或重复。');
    if (typeof entry.source !== 'string' || !entry.source.trim() || !['development', 'heldout', 'contract'].includes(entry.split) || !['human', 'constructed'].includes(entry.labelOrigin) || !VERDICTS.includes(entry.referenceVerdict)) throw new Error('Judge 验收来源、划分或参考标签无效。');
    const request = entry.request;
    if (!request || !request.case || typeof request.case.id !== 'string' || typeof request.case.name !== 'string' || typeof request.case.expected !== 'string' || !Object.hasOwn(request.case, 'input') || !Object.hasOwn(request, 'output') || !Array.isArray(request.trace) || !Array.isArray(request.criteria) || request.criteria.some((criterion) => typeof criterion !== 'string')) throw new Error('Judge 验收请求结构无效。');
    const encoded = JSON.stringify(entry);
    if (!encoded || Buffer.byteLength(encoded) > 1024 * 1024) throw new Error('单条 Judge 验收用例超过 1 MiB。');
    ids.add(entry.id);
  }
}

function validateRepeats(repeats) {
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5) throw new Error('Judge 验收重复次数必须是 1–5。');
}

function ratio(numerator, denominator) {
  if (denominator === 0) return { numerator, denominator, rate: null, wilson95: null };
  const rate = numerator / denominator;
  const z = 1.959963984540054;
  const correction = 1 + z ** 2 / denominator;
  const center = (rate + z ** 2 / (2 * denominator)) / correction;
  const radius = z * Math.sqrt(rate * (1 - rate) / denominator + z ** 2 / (4 * denominator ** 2)) / correction;
  return { numerator, denominator, rate, wilson95: { lower: Math.max(0, center - radius), upper: Math.min(1, center + radius) } };
}

function outcome(trial) {
  if (!trial) return 'not_run';
  return trial.status === 'completed' && VERDICTS.includes(trial.verdict) ? trial.verdict : 'error';
}

function metricsFor(cases, trials, repeats) {
  const casesById = new Map(cases.map((entry) => [entry.id, entry]));
  const relevant = trials.filter((trial) => casesById.has(trial.caseId));
  const byKey = new Map(relevant.map((trial) => [`${trial.caseId}:${trial.trial}`, trial]));
  const matrix = Object.fromEntries(VERDICTS.map((reference) => [reference, Object.fromEntries(OUTCOMES.map((prediction) => [prediction, 0]))]));
  let correct = 0;
  let eligible = 0;
  let consistent = 0;
  for (const entry of cases) {
    const first = outcome(byKey.get(`${entry.id}:1`));
    matrix[entry.referenceVerdict][first]++;
    if (first === entry.referenceVerdict) correct++;
    const observations = Array.from({ length: repeats }, (_, index) => byKey.get(`${entry.id}:${index + 1}`));
    if (observations.every((trial) => trial?.status === 'completed' && VERDICTS.includes(trial.verdict))) {
      eligible++;
      if (observations.every((trial) => trial.verdict === observations[0].verdict)) consistent++;
    }
  }
  const referenceCount = (verdict) => cases.filter((entry) => entry.referenceVerdict === verdict).length;
  const binaryN = referenceCount('pass') + referenceCount('fail');
  const binaryDecisions = matrix.pass.pass + matrix.pass.fail + matrix.fail.pass + matrix.fail.fail;
  const completed = relevant.filter((trial) => trial.status === 'completed').length;
  const errors = relevant.filter((trial) => trial.status === 'error').length;
  const cancelled = relevant.filter((trial) => trial.status === 'cancelled').length;
  const missing = VERDICTS.reduce((sum, verdict) => sum + matrix[verdict].not_run, 0);
  const firstErrors = VERDICTS.reduce((sum, verdict) => sum + matrix[verdict].error, 0);
  return {
    caseCount: cases.length,
    attempts: { planned: cases.length * repeats, started: relevant.length, completed: relevant.length, successful: completed, error: errors, cancelled, notRun: cases.length * repeats - relevant.length },
    primary: { n: cases.length, correct, accuracy: ratio(correct, cases.length), confusionMatrix: matrix, missing, error: firstErrors },
    binaryDetection: {
      n: binaryN,
      coverage: ratio(binaryDecisions, binaryN),
      accuracy: ratio(matrix.pass.pass + matrix.fail.fail, binaryN),
      falsePositive: ratio(matrix.pass.fail, referenceCount('pass')),
      falseNegative: ratio(matrix.fail.pass, referenceCount('fail')),
      failAbstention: ratio(matrix.fail.pending, referenceCount('fail')),
      error: ratio(matrix.pass.error + matrix.fail.error, binaryN),
      notRun: ratio(matrix.pass.not_run + matrix.fail.not_run, binaryN),
    },
    repeatStability: {
      repeats,
      eligible,
      excluded: cases.length - eligible,
      consistent,
      // A single observation cannot measure repeat stability.
      agreement: repeats > 1 ? ratio(consistent, eligible) : ratio(0, 0),
    },
  };
}

/** Primary rates use the first scheduled repeat, one observation per Case.
 * Repeated calls never inflate the confidence-interval sample size. */
export function computeJudgeMetrics(cases, trials, { repeats = 2 } = {}) {
  validateCases(cases);
  validateRepeats(repeats);
  if (!Array.isArray(trials)) throw new Error('Judge 验收结果必须是数组。');
  const ids = new Set(cases.map((entry) => entry.id));
  const keys = new Set();
  for (const trial of trials) {
    const key = `${trial.caseId}:${trial.trial}`;
    if (!ids.has(trial.caseId) || !Number.isInteger(trial.trial) || trial.trial < 1 || trial.trial > repeats || keys.has(key)) throw new Error('Judge 验收结果引用未知用例、轮次无效或重复。');
    if (!['completed', 'error', 'cancelled'].includes(trial.status) || (trial.status === 'completed' && !VERDICTS.includes(trial.verdict))) throw new Error('Judge 验收结果状态无效。');
    keys.add(key);
  }
  const groups = (field) => Object.fromEntries([...new Set(cases.map((entry) => entry[field]))].sort().map((value) => [value, metricsFor(cases.filter((entry) => entry[field] === value), trials, repeats)]));
  const strataKeys = [...new Set(cases.map((entry) => JSON.stringify([entry.source, entry.split, entry.labelOrigin])))].sort();
  return {
    version: 1,
    definitions: {
      primary: '首轮三分类严格匹配；参考 pending 与预测 pending 匹配。错误和未调用均不匹配；分母为选定用例数。',
      binaryDetection: '仅参考 pass/fail；fail 为检测阳性。coverage 为给出 pass/fail 的比例；pending、error、not_run 不计准确。',
      falsePositive: '参考 pass、预测 fail / 所有参考 pass；仅首轮。',
      falseNegative: '参考 fail、预测 pass / 所有参考 fail；pending 另列为 failAbstention。',
      repeatStability: '只纳入所有轮次都完成有效判定的用例；全部判定相同计一致。一次运行无法估计重复一致率。',
      uncertainty: '95% Wilson 区间按首轮 Case 数计算；重复未作为独立样本。区间假设 Case 独立，无法消除来源或同组相关性。',
      provenance: 'overall 仅诊断；human 与 constructed、development 与 heldout 必须分开解释，不能合并宣称人工验收准确率。',
      attempts: 'started/completed 为已持久化的终态调用数，含 error/cancelled；successful 仅有效模型判定。硬退出后未结束调用需结合 calls.jsonl 核查。',
    },
    overall: metricsFor(cases, trials, repeats),
    bySource: groups('source'),
    bySplit: groups('split'),
    byLabelOrigin: groups('labelOrigin'),
    strata: strataKeys.map((key) => {
      const [source, split, labelOrigin] = JSON.parse(key);
      return { source, split, labelOrigin, ...metricsFor(cases.filter((entry) => entry.source === source && entry.split === split && entry.labelOrigin === labelOrigin), trials, repeats) };
    }),
  };
}

function safeError(error, wasCancelled = false) {
  const errorCode = wasCancelled ? 'ABORT_ERR' : typeof error?.code === 'string' && /^[A-Z0-9_]{1,60}$/.test(error.code) ? error.code : 'JUDGE_ERROR';
  return { errorCode, reason: wasCancelled ? '本次模型判定已取消，未生成判定。' : `本次模型判定失败（${errorCode}），未生成判定。` };
}

async function invokeJudge(judge, request, externalSignal) {
  if (externalSignal.aborted) throw Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' });
  const controller = new AbortController();
  const signal = AbortSignal.any([externalSignal, controller.signal]);
  let abort;
  const interrupted = new Promise((_, reject) => {
    abort = () => reject(Object.assign(new Error('interrupted'), { code: externalSignal.aborted ? 'ABORT_ERR' : 'JUDGE_TIMEOUT' }));
    signal.addEventListener('abort', abort, { once: true });
  });
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    return await Promise.race([Promise.resolve().then(() => judge({ ...cloneJson(request), signal })), interrupted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

/** The injected scheduler is for deterministic harness tests. Real runs use
 * Promptfoo's evaluate function as their only batch scheduler. */
export async function runJudgeBenchmark({ cases, directory, judge, judgeInfo = {}, repeats = 2, concurrency = 2, signal: externalSignal, onProgress, scheduler }) {
  validateCases(cases);
  validateRepeats(repeats);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('Judge 验收并发数必须是 1–4。');
  if (typeof judge !== 'function') throw new Error('Judge 验收需要已配置的模型打分器。');
  if (scheduler !== undefined && typeof scheduler !== 'function') throw new Error('Judge 验收调度器无效。');
  if (typeof directory !== 'string' || !directory.trim()) throw new Error('Judge 验收需要独立输出目录。');
  // Freeze the complete dataset and request projections before any async work.
  const frozenCases = cloneJson(cases);
  const frozenJudgeInfo = cloneJson(judgeInfo);
  const byId = new Map(frozenCases.map((entry) => [entry.id, entry]));
  const requests = new Map(frozenCases.map((entry) => [entry.id, judgeRequest(entry)]));
  const requestHashes = new Map([...requests].map(([id, request]) => [id, hash(request)]));
  const resultDirectory = path.resolve(directory);
  await mkdir(path.dirname(resultDirectory), { recursive: true });
  // mkdir without recursive is also an atomic reservation against concurrent
  // invocations and refuses existing directories, even empty ones or symlinks.
  try { await mkdir(resultDirectory); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Judge 验收输出目录已存在，拒绝覆盖历史证据。');
    throw error;
  }
  const controller = new AbortController();
  const signal = externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal;
  const run = { id: `judge-benchmark-${randomUUID()}`, directory: resultDirectory, status: 'running', planned: frozenCases.length * repeats, started: 0, completed: 0, repeats, concurrency, judgeInfo: frozenJudgeInfo, startedAt: new Date().toISOString(), trials: [] };
  const manifest = {
    version: 1, id: run.id, startedAt: run.startedAt,
    datasetSha256: hash(frozenCases), hashAlgorithm: 'sha256-canonical-json-sorted-object-keys',
    judgeInfo: frozenJudgeInfo,
    scheduler: scheduler ? 'injected-test-scheduler' : 'promptfoo',
    budget: { cases: frozenCases.length, repeats, plannedCalls: run.planned, maxConcurrency: concurrency, retries: 0, perCallHardTimeoutMs: 90_000 },
    requests: frozenCases.map((entry) => ({ id: entry.id, source: entry.source, split: entry.split, labelOrigin: entry.labelOrigin, requestSha256: requestHashes.get(entry.id) })),
    isolation: '每次只调用现有 judge，传入当前用例的独立请求副本；参考标签与标注说明不进入 Judge。模型会话和缓存隔离由 models.judge 实现。',
    evaluation: 'cases.json 保存参考标签供验收统计；这些字段不在 Promptfoo provider 请求中。首次运行用于准确率，重复用于稳定性。',
  };
  await writeFile(path.join(resultDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2), { encoding: 'utf8', flag: 'wx' });
  await writeFile(path.join(resultDirectory, 'cases.json'), JSON.stringify(frozenCases, null, 2), { encoding: 'utf8', flag: 'wx' });
  await writeFile(path.join(resultDirectory, 'calls.jsonl'), '', { encoding: 'utf8', flag: 'wx' });
  await writeFile(path.join(resultDirectory, 'trials.jsonl'), '', { encoding: 'utf8', flag: 'wx' });
  await writeFile(path.join(resultDirectory, 'run.json'), JSON.stringify(run, null, 2), { encoding: 'utf8', flag: 'wx' });
  let writes = Promise.resolve();
  const serialize = (action) => {
    const next = writes.then(action);
    writes = next;
    return next;
  };
  const snapshot = async () => {
    await writeFile(path.join(resultDirectory, 'run.json.tmp'), JSON.stringify(run, null, 2), 'utf8');
    await rename(path.join(resultDirectory, 'run.json.tmp'), path.join(resultDirectory, 'run.json'));
  };
  let observerFailures = 0;
  const progress = async (phase, caseId, trial) => {
    try { await onProgress?.({ phase, caseId, trial, started: run.started, completed: run.completed, total: run.planned }, run); }
    catch { observerFailures++; }
  };
  const invoked = new Set();
  const active = new Set();
  async function execute(context) {
    if (signal.aborted) return { error: '运行已取消。' };
    const caseId = context?.vars?.caseId;
    const trialNumber = (context?.repeatIndex ?? 0) + 1;
    const entry = byId.get(caseId);
    if (!entry || !Number.isInteger(trialNumber) || trialNumber < 1 || trialNumber > repeats) throw new Error('调度器返回未知用例或轮次。');
    const id = `${caseId}-r${trialNumber}`;
    // Never allow provider retry or duplicate scheduler invocations to consume
    // extra calls or duplicate observations in the accuracy denominator.
    if (invoked.has(id)) throw new Error('调度器重复调用同一用例轮次，已拒绝。');
    invoked.add(id);
    const trial = { id, caseId, trial: trialNumber, invocationId: randomUUID(), status: 'error', verdict: null, reason: '', requestSha256: requestHashes.get(caseId), startedAt: new Date().toISOString(), durationMs: 0 };
    const started = performance.now();
    await serialize(async () => {
      await appendFile(path.join(resultDirectory, 'calls.jsonl'), `${JSON.stringify({ id, caseId, trial: trialNumber, invocationId: trial.invocationId, requestSha256: trial.requestSha256, startedAt: trial.startedAt })}\n`, 'utf8');
      run.started++;
      await snapshot();
    });
    await progress('grading', caseId, trialNumber);
    try {
      const result = await invokeJudge(judge, requests.get(caseId), signal);
      if (!result || !VERDICTS.includes(result.verdict) || typeof result.reason !== 'string' || !result.reason.trim()) throw Object.assign(new Error('Invalid judge output'), { code: 'JUDGE_INVALID_OUTPUT' });
      trial.status = 'completed';
      trial.verdict = result.verdict;
      trial.reason = result.reason;
    } catch (error) {
      const wasCancelled = signal.aborted || error.code === 'ABORT_ERR';
      trial.status = wasCancelled ? 'cancelled' : 'error';
      Object.assign(trial, safeError(error, wasCancelled));
    }
    trial.durationMs = Math.round(performance.now() - started);
    trial.finishedAt = new Date().toISOString();
    await serialize(async () => {
      // Append-only evidence is committed before publishing a mutable snapshot
      // or calling a user observer; neither can erase a finished verdict.
      await appendFile(path.join(resultDirectory, 'trials.jsonl'), `${JSON.stringify(trial)}\n`, 'utf8');
      run.trials.push(trial);
      run.completed++;
      await snapshot();
    });
    await progress('completed', caseId, trialNumber);
    return trial.status === 'completed'
      ? { output: JSON.stringify({ verdict: trial.verdict, reason: trial.reason }), metadata: { trialId: id } }
      : { error: trial.reason, metadata: { trialId: id } };
  }
  const provider = {
    id: () => `evalpi-judge-benchmark-${run.id}`,
    callApi(_prompt, context) {
      const task = execute(context);
      active.add(task);
      task.then(() => active.delete(task), () => active.delete(task));
      return task;
    },
  };
  try {
    if (!signal.aborted) {
      const evaluate = scheduler ?? (await promptfoo()).evaluate;
      await evaluate({
        description: 'EvalPi Judge reliability benchmark',
        prompts: ['{{caseId}}'], providers: [provider],
        // Promptfoo receives only opaque IDs, never dataset labels or evidence.
        tests: frozenCases.map((entry) => ({ vars: { caseId: entry.id } })),
        writeLatestResults: false, sharing: false,
      }, { maxConcurrency: concurrency, repeat: repeats, cache: false, showProgressBar: false, silent: true, abortSignal: signal });
    }
    await Promise.allSettled([...active]);
    run.status = signal.aborted ? 'cancelled' : run.completed === run.planned ? 'completed' : 'interrupted';
  } catch (error) {
    controller.abort();
    await Promise.allSettled([...active]);
    run.status = externalSignal?.aborted ? 'cancelled' : 'failed';
    run.error = safeError(error, Boolean(externalSignal?.aborted));
  }
  await writes;
  run.finishedAt = new Date().toISOString();
  run.observerFailures = observerFailures;
  run.summary = computeJudgeMetrics(frozenCases, run.trials, { repeats });
  await writeFile(path.join(resultDirectory, 'summary.json'), JSON.stringify(run.summary, null, 2), { encoding: 'utf8', flag: 'wx' });
  await snapshot();
  return run;
}
