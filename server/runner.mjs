import { spawn } from 'node:child_process';
import { appendFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { resolveProjectFile } from './project.mjs';
import { MIN_TARGET_TIMEOUT_MS, MAX_TARGET_TIMEOUT_MS } from './limits.mjs';

const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
let promptfooPromise;

async function getPromptfoo() {
  // This local harness never needs cloud sharing, usage telemetry or model calls
  // from Promptfoo. The supplied custom provider is its only execution target.
  process.env.PROMPTFOO_DISABLE_TELEMETRY = '1';
  process.env.PROMPTFOO_DISABLE_UPDATE = '1';
  process.env.PROMPTFOO_DISABLE_REMOTE_GENERATION = 'true';
  process.env.PROMPTFOO_CACHE_ENABLED = 'false';
  promptfooPromise ??= import('promptfoo');
  return promptfooPromise;
}

function failure(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function cancelled() { return failure('用户已取消运行。', 'ABORT_ERR'); }

function isolatedEnvironment(workDirectory) {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {
    ...env,
    ELECTRON_RUN_AS_NODE: '1',
    HOME: workDirectory,
    USERPROFILE: workDirectory,
    APPDATA: workDirectory,
    LOCALAPPDATA: workDirectory,
    TMPDIR: workDirectory,
    TMP: workDirectory,
    TEMP: workDirectory,
    XDG_CONFIG_HOME: workDirectory,
    XDG_CACHE_HOME: workDirectory,
    EVALPI_WORK_DIR: workDirectory,
    EVALPI_ISOLATED_TRIAL: '1',
  };
}

function killProcessTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    const killer = spawn(executable, ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
    killer.on('error', () => child.kill('SIGKILL'));
    const fallback = setTimeout(() => child.kill('SIGKILL'), 1000);
    fallback.unref();
    child.once('close', () => clearTimeout(fallback));
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch { child.kill('SIGKILL'); }
  }
}

async function executeTarget({ entry, evalCase, trial, sessionId, workDirectory, timeoutMs, signal }) {
  if (signal?.aborted) throw cancelled();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], {
      cwd: workDirectory,
      env: isolatedEnvironment(workDirectory),
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let terminalError;
    const stop = (error) => {
      if (terminalError) return;
      terminalError = error;
      killProcessTree(child);
    };
    const abort = () => stop(cancelled());
    const timer = setTimeout(() => stop(failure(`目标进程超过 ${timeoutMs} ms，已终止。`, 'TARGET_TIMEOUT')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.stdout.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT_BYTES) stop(failure('目标输出超过 1 MiB，已终止。', 'OUTPUT_LIMIT'));
      else stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT_BYTES) stop(failure('目标输出超过 1 MiB，已终止。', 'OUTPUT_LIMIT'));
      if (Buffer.byteLength(stderr) < MAX_STDERR_BYTES) stderr += chunk.slice(0, MAX_STDERR_BYTES - stderr.length);
    });
    child.on('error', (error) => { cleanup(); reject(failure(`无法启动目标进程：${error.message}`, 'SPAWN_ERROR')); });
    child.stdin.on('error', () => { /* Early exit is handled by close, never crash the host on EPIPE. */ });
    child.once('close', (code, exitSignal) => {
      cleanup();
      if (terminalError) return reject(terminalError);
      if (code !== 0) return reject(failure(`目标进程异常退出（${code ?? exitSignal}）。${stderr.trim() ? ` ${stderr.trim().slice(0, 2000)}` : ''}`, 'TARGET_EXIT'));
      try {
        const output = JSON.parse(stdout.trim());
        if (!output || typeof output !== 'object' || Array.isArray(output)) throw new Error('输出应为 JSON 对象');
        resolve(output);
      } catch (error) {
        reject(failure(`目标未返回有效 JSON：${error.message}`, 'INVALID_OUTPUT'));
      }
    });
    child.stdin.end(`${JSON.stringify({ input: evalCase.input, caseId: evalCase.id, trial, sessionId })}\n`);
    if (signal?.aborted) abort();
  });
}

async function collectBusinessState(workDirectory, stateFile) {
  if (!stateFile) return undefined;
  if (!/^[\w-]+\.json$/.test(stateFile)) throw failure('业务状态文件必须位于试验工作目录内。', 'INVALID_STATE_PATH');
  const filename = path.join(workDirectory, stateFile);
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STATE_BYTES) throw failure('业务状态文件无效、为符号链接或超过 1 MiB。', 'INVALID_STATE');
  return JSON.parse(await readFile(filename, 'utf8'));
}

async function callJudge(judge, args) {
  if (args.signal?.aborted) throw cancelled();
  const controller = new AbortController();
  const signal = args.signal ? AbortSignal.any([args.signal, controller.signal]) : controller.signal;
  let abort;
  const interrupted = new Promise((_, reject) => {
    abort = () => reject(args.signal?.aborted ? cancelled() : failure('模型评分超过 90 秒，目标执行证据已保留。', 'JUDGE_TIMEOUT'));
    signal.addEventListener('abort', abort, { once: true });
  });
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    return await Promise.race([Promise.resolve().then(() => judge({ ...args, signal })), interrupted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

function getAt(object, dottedPath) {
  let current = object;
  for (const key of dottedPath.split('.')) {
    if (['__proto__', 'constructor', 'prototype'].includes(key) || current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

/** Re-score stored evidence only. This function never executes the target. */
export function scoreRules(project, evalCase, output) {
  const defined = project.manifest?.cases?.find((candidate) => candidate.id === evalCase.id);
  if (!defined || !isDeepStrictEqual(defined.input, evalCase.input) || defined.expected !== evalCase.expected) {
    return { verdict: 'pending', reason: '用例与已声明的检查规则不一致，需要补充评判依据。' };
  }
  const checks = defined.checks;
  if (!Array.isArray(checks) || checks.length === 0) return { verdict: 'pending', reason: '此用例尚无可执行规则，请配置模型评分或补充明确检查。' };
  const violations = [];
  for (const check of checks) {
    const actual = getAt(output, check.path);
    const pass = check.op === 'equals' ? isDeepStrictEqual(actual, check.value)
      : check.op === 'includes' ? (typeof actual === 'string' && typeof check.value === 'string' ? actual.includes(check.value) : Array.isArray(actual) && actual.some((value) => isDeepStrictEqual(value, check.value)))
        : check.op === 'exists' ? (check.value === false ? actual === undefined : actual !== undefined)
          : false;
    if (!pass) violations.push(`${check.path}：预期 ${check.op} ${JSON.stringify(check.value) ?? '存在'}，实际 ${JSON.stringify(actual)?.slice(0, 300) ?? '缺失'}`);
  }
  return violations.length ? { verdict: 'fail', reason: violations.join('；') } : { verdict: 'pass', reason: `${checks.length} 条明确检查全部通过，已核对保存的执行证据。` };
}

function validatePlan(project, plan) {
  if (!project?.path || !plan?.confirmed) throw new Error('评测方案需要用户确认后才能执行。');
  if (typeof plan.id !== 'string' || !/^[\w-]{1,100}$/.test(plan.id)) throw new Error('评测方案 id 无效。');
  if (!Number.isInteger(plan.repeats) || plan.repeats < 1 || plan.repeats > 10) throw new Error('重复次数必须是 1–10。');
  if (!Number.isInteger(plan.timeoutMs) || plan.timeoutMs < MIN_TARGET_TIMEOUT_MS || plan.timeoutMs > MAX_TARGET_TIMEOUT_MS) throw new Error(`单次超时必须是 ${MIN_TARGET_TIMEOUT_MS}–${MAX_TARGET_TIMEOUT_MS} ms。`);
  if (!Array.isArray(plan.cases) || plan.cases.length < 1 || plan.cases.length > 50) throw new Error('单轮方案需要 1–50 条用例。');
  if (!['rules', 'llm'].includes(plan.judge)) throw new Error('评分器类型无效。');
  if (!project.manifest || plan.entry !== project.manifest.entry) throw new Error('执行入口必须与已检查的项目协议一致。');
  if (typeof plan.entry !== 'string' || !/\.(?:mjs|cjs|js)$/i.test(plan.entry)) throw new Error('入口必须是 JavaScript 文件。');
  const ids = new Set();
  for (const entry of plan.cases) {
    if (!entry || typeof entry.id !== 'string' || !/^[\w-]{1,64}$/.test(entry.id) || ids.has(entry.id) || !entry.input || typeof entry.input !== 'object' || Array.isArray(entry.input) || typeof entry.expected !== 'string') throw new Error('测试用例结构或 id 无效。');
    if (JSON.stringify(entry.input).length > 16_000) throw new Error('测试输入超过大小限制。');
    ids.add(entry.id);
  }
}

async function writeSnapshot(run) {
  const temporary = path.join(run.directory, 'run.json.tmp');
  await writeFile(temporary, JSON.stringify(run, null, 2), 'utf8');
  await rename(temporary, path.join(run.directory, 'run.json'));
}

async function cleanTrial(workDirectory) {
  const temporaryRoot = await realpath(os.tmpdir());
  const resolved = path.resolve(workDirectory);
  const relative = path.relative(temporaryRoot, resolved);
  if (relative.startsWith('evalpi-trial-') && !relative.includes(path.sep) && !path.isAbsolute(relative)) {
    await rm(resolved, { recursive: true, force: true });
  }
}

/** Promptfoo is the sole batch scheduler; each provider call owns a fresh process. */
export async function runEvaluation({ project, plan, directory, judge, judgeInfo, signal: externalSignal, onStart, onTrial, onProgress }) {
  validatePlan(project, plan);
  const entry = await resolveProjectFile(project.path, plan.entry);
  const entrySha256 = createHash('sha256').update(await readFile(entry)).digest('hex');
  const batchController = new AbortController();
  const signal = externalSignal ? AbortSignal.any([externalSignal, batchController.signal]) : batchController.signal;
  let entryMutation;
  const resultDirectory = path.resolve(directory);
  await mkdir(resultDirectory, { recursive: true });
  // Refuse accidental overwrite of an earlier run or symlink-based evidence file.
  const runFile = path.join(resultDirectory, 'run.json');
  const run = {
    id: `run-${randomUUID()}`, planId: plan.id, projectPath: project.path,
    status: 'running', startedAt: new Date().toISOString(), planned: plan.cases.length * plan.repeats,
    trials: [], reviews: {}, directory: resultDirectory,
  };
  if (judgeInfo) run.judge = { provider: judgeInfo.provider, model: judgeInfo.model, authMode: judgeInfo.authMode };
  await writeFile(runFile, JSON.stringify(run, null, 2), { encoding: 'utf8', flag: 'wx' });
  // Publish the durable run reference before importing the scheduler or spawning
  // any target, so a crash during the first trial can be recovered by the host.
  let startError;
  try { await onStart?.(run); } catch (error) { startError = error; }
  await writeFile(path.join(resultDirectory, 'plan.json'), JSON.stringify(plan, null, 2), { encoding: 'utf8', flag: 'wx' });
  await writeFile(path.join(resultDirectory, 'trials.jsonl'), '', { encoding: 'utf8', flag: 'wx' });
  await writeFile(path.join(resultDirectory, 'executions.jsonl'), '', { encoding: 'utf8', flag: 'wx' });
  await writeFile(path.join(resultDirectory, 'execution.json'), JSON.stringify({
    entry: plan.entry, entrySha256, hashScope: 'entry-file-only',
    note: '每次启动前核验入口文件；依赖文件、外部服务和业务数据未冻结。',
  }, null, 2), { encoding: 'utf8', flag: 'wx' });
  let observerError;
  let completed = 0;
  const progress = async (phase, evalCase, trialNumber) => {
    try { await onProgress?.({ phase, caseId: evalCase.id, trial: trialNumber, completed, total: run.planned }, run); }
    catch (error) { observerError ??= error; }
  };
  const byId = new Map(plan.cases.map((value) => [value.id, value]));
  const provider = {
    id: () => `evalpi-local-${run.id}`,
    async callApi(_prompt, context) {
      if (signal?.aborted) return { error: '运行已取消。' };
      const evalCase = byId.get(context.vars.caseId);
      const trialNumber = (context.repeatIndex ?? 0) + 1;
      const sessionId = randomUUID();
      const workDirectory = await mkdtemp(path.join(await realpath(os.tmpdir()), 'evalpi-trial-'));
      const startedAt = performance.now();
      const trial = { id: `${evalCase.id}-${trialNumber}`, caseId: evalCase.id, trial: trialNumber, sessionId, status: 'completed', trace: [], verdict: 'pending', reason: '', durationMs: 0, judgeSource: 'none', grading: { status: 'not_run', durationMs: 0 } };
      await progress('executing', evalCase, trialNumber);
      try {
        // This fingerprint covers only the selected entry file, not dependencies.
        try {
          const currentEntry = await resolveProjectFile(project.path, plan.entry);
          const currentSha256 = createHash('sha256').update(await readFile(currentEntry)).digest('hex');
          if (currentEntry !== entry || currentSha256 !== entrySha256) throw new Error('入口内容变化');
        } catch {
          entryMutation = failure('检测到项目入口文件变化，已停止剩余评测。请重新检查项目并确认方案。', 'ENTRY_CHANGED');
          batchController.abort(entryMutation);
          throw entryMutation;
        }
        trial.output = await executeTarget({ entry, evalCase, trial: trialNumber, sessionId, workDirectory, timeoutMs: plan.timeoutMs, signal });
        // This reserved evidence field is exclusively populated by the harness.
        delete trial.output.observedState;
        trial.durationMs = Math.round(performance.now() - startedAt);
        trial.trace = Array.isArray(trial.output.trace) ? trial.output.trace : [];
        if (project.manifest.stateFile) {
          try {
            trial.output.observedState = await collectBusinessState(workDirectory, project.manifest.stateFile);
            trial.trace.push({ type: 'harness_state_snapshot', file: project.manifest.stateFile, state: trial.output.observedState });
          } catch (error) {
            trial.verdict = 'pending';
            trial.reason = `目标已执行，业务状态证据无法读取：${error.message}`;
          }
        }
      } catch (error) {
        trial.durationMs ||= Math.round(performance.now() - startedAt);
        trial.status = error.code === 'ENTRY_CHANGED' ? 'error' : error.code === 'ABORT_ERR' || signal.aborted ? 'cancelled' : 'error';
        trial.verdict = 'error';
        trial.reason = error.message;
        trial.error = error.message;
        trial.trace.push({ type: 'harness_error', code: error.code ?? 'UNKNOWN', message: error.message });
      } finally {
        try { await cleanTrial(workDirectory); }
        catch (error) { trial.trace.push({ type: 'harness_cleanup_warning', message: error.message, directory: workDirectory }); }
      }
      if (trial.status === 'completed') {
        trial.ruleResult = trial.reason ? { verdict: 'pending', reason: trial.reason } : scoreRules(project, evalCase, trial.output);
        if (!trial.reason) {
          Object.assign(trial, trial.ruleResult);
          trial.judgeSource = 'rules';
          if (plan.judge === 'llm' && trial.verdict !== 'fail') {
            trial.verdict = 'pending';
            trial.reason = '目标已执行，等待模型评分。';
          }
        }
      }
      // Execution evidence is durable before any model request. Keep one mutable
      // trial in run.json so recovery can show the output even mid-grading; the
      // append-only execution record remains unchanged by later model opinions.
      run.trials.push(trial);
      await appendFile(path.join(resultDirectory, 'executions.jsonl'), `${JSON.stringify(trial)}\n`, 'utf8');
      await writeSnapshot(run);
      const missingEvidence = trial.status === 'completed' && trial.judgeSource === 'none';
      if (trial.status === 'completed' && !missingEvidence && plan.judge === 'llm') {
        trial.judgeSource = 'llm';
        await progress('grading', evalCase, trialNumber);
        const gradingStartedAt = performance.now();
        try {
          if (!judge) throw failure('尚未配置模型评分器。', 'JUDGE_UNAVAILABLE');
          const scored = await callJudge(judge, { case: evalCase, output: trial.output, trace: trial.trace, signal });
          if (!scored || !['pass', 'fail', 'pending'].includes(scored.verdict) || typeof scored.reason !== 'string') throw failure('模型评分结果格式无效。', 'JUDGE_INVALID_OUTPUT');
          trial.grading = { status: 'completed', verdict: scored.verdict, reason: scored.reason, durationMs: Math.round(performance.now() - gradingStartedAt) };
          // Observable business-rule violations remain a hard gate, including
          // when grading later fails or the user cancels a model request.
          Object.assign(trial, trial.ruleResult.verdict === 'fail' ? { verdict: 'fail', reason: `${trial.ruleResult.reason}；模型复核：${scored.reason}` } : scored);
        } catch (error) {
          const wasCancelled = error.code === 'ABORT_ERR' || signal.aborted;
          trial.grading = { status: wasCancelled ? 'cancelled' : 'error', reason: error.message, errorCode: error.code ?? 'JUDGE_ERROR', durationMs: Math.round(performance.now() - gradingStartedAt) };
          trial.verdict = trial.ruleResult.verdict === 'fail' ? 'fail' : 'pending';
          trial.reason = `${trial.ruleResult.verdict === 'fail' ? `${trial.ruleResult.reason}；` : ''}目标已执行，评分未完成：${error.message}`;
          trial.trace.push({ type: 'grading_error', code: trial.grading.errorCode, message: error.message });
        }
      } else if (trial.status === 'completed' && !missingEvidence) {
        trial.grading = { status: 'completed', ...trial.ruleResult, durationMs: 0 };
      }
      completed++;
      await appendFile(path.join(resultDirectory, 'trials.jsonl'), `${JSON.stringify(trial)}\n`, 'utf8');
      await writeSnapshot(run);
      try { await onTrial?.(trial, run); } catch (error) { observerError ??= error; }
      return trial.status === 'completed'
        ? { output: JSON.stringify({ verdict: trial.verdict, reason: trial.reason }), metadata: { trialId: trial.id } }
        : { error: trial.error ?? trial.reason, metadata: { trialId: trial.id } };
    },
  };
  try {
    if (startError) throw startError;
    if (!signal?.aborted) {
      const { evaluate } = await getPromptfoo();
      await evaluate({
        description: plan.title,
        prompts: ['{{caseId}}'],
        providers: [provider],
        tests: plan.cases.map((evalCase) => ({ description: evalCase.name, vars: { caseId: evalCase.id }, assert: [{ type: 'javascript', value: (output) => JSON.parse(output).verdict === 'pass' }] })),
        writeLatestResults: false,
        sharing: false,
      }, { maxConcurrency: 1, repeat: plan.repeats, cache: false, showProgressBar: false, silent: true, abortSignal: signal });
    }
    run.status = entryMutation ? 'failed' : signal.aborted ? 'cancelled' : run.trials.length === run.planned ? 'completed' : 'interrupted';
  } catch (error) {
    run.status = entryMutation ? 'failed' : signal.aborted ? 'cancelled' : 'failed';
    await writeFile(path.join(resultDirectory, 'run-error.json'), JSON.stringify({ message: entryMutation?.message ?? error.message, code: entryMutation?.code ?? error.code, at: new Date().toISOString() }, null, 2), 'utf8');
  }
  if (entryMutation) await writeFile(path.join(resultDirectory, 'run-error.json'), JSON.stringify({ message: entryMutation.message, code: entryMutation.code, at: new Date().toISOString() }, null, 2), 'utf8');
  if (observerError) await writeFile(path.join(resultDirectory, 'observer-error.json'), JSON.stringify({ message: observerError.message }, null, 2), 'utf8');
  run.finishedAt = new Date().toISOString();
  await writeSnapshot(run);
  return run;
}
