import { EventEmitter } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { readJson, serialWriter, writeJson } from './store.mjs';
import { inspectProject, createFixturePlan } from './project.mjs';
import { runEvaluation, scoreRules } from './runner.mjs';
import { createModels } from './models.mjs';
import { createReport } from './reports.mjs';
import { MIN_TARGET_TIMEOUT_MS, MAX_TARGET_TIMEOUT_MS } from './limits.mjs';

export async function createRuntime({ dataDir, appRoot, modelsDataDir = path.join(dataDir, 'models'), modelsFactory = createModels, runner = runEvaluation, pdfRenderer }) {
  await mkdir(dataDir, { recursive: true });
  const stateFile = path.join(dataDir, 'workspace.json');
  const persist = serialWriter(stateFile);
  const saved = await readJson(stateFile, {});
  const state = { project: null, plan: null, run: null, messages: [], ...saved, busy: false, activity: '', error: null, model: { provider: 'openai', model: '', authenticated: false, authMode: 'none', availableModels: [] } };
  if (state.run) {
    // The execution record can be newer than workspace.json if the host stopped
    // between a durable target output and the following UI notification.
    try {
      const runsRoot = await realpath(path.join(dataDir, 'runs'));
      const runDirectory = await realpath(state.run.directory);
      const relative = path.relative(runsRoot, runDirectory);
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        const latest = await readJson(path.join(runDirectory, 'run.json'));
        if (latest?.id === state.run.id && latest.planId === state.run.planId && Array.isArray(latest.trials)) state.run = latest;
      }
    } catch { /* Keep the last workspace snapshot if no newer run can be read. */ }
    if (state.run.status === 'running') {
      for (const trial of state.run.trials) {
        if (state.run.judge && trial.judgeSource !== 'none' && trial.status === 'completed' && trial.output && trial.grading?.status === 'not_run') {
          trial.grading = { ...trial.grading, status: 'cancelled', errorCode: 'APP_INTERRUPTED', reason: '应用中断时评分尚未完成，已有执行证据已保留。' };
          if (trial.ruleResult?.verdict !== 'fail') trial.verdict = 'pending';
        }
      }
      state.run.status = 'interrupted';
      state.error = '上次运行意外中断，已保留执行证据。未完成的模型评分可单独重试。';
    }
  }
  const events = new EventEmitter();
  let controller = null, work = Promise.resolve(), shortWork = Promise.resolve(), loginWork = null, revision = saved.revision ?? null, closing = false;
  const snapshot = () => structuredClone(state);
  function emit() { events.emit('event', { type: 'state', state: snapshot() }); }
  async function save() {
    const { model, ...publicState } = state;
    await persist({ ...publicState, revision });
    emit();
  }
  const models = await modelsFactory({ dataDir: modelsDataDir, onAuthUpdate: async (status, error) => {
    if (status) state.model = status;
    if (error) state.error = String(error.message ?? error);
    state.activity = '';
    emit();
  } });
  state.model = await models.status();
  await save();
  const append = (role, text, artifact) => state.messages.push({ id: randomUUID(), role, text, createdAt: new Date().toISOString(), ...(artifact ? { artifact } : {}) });
  const requireIdle = () => { if (closing) throw new Error('应用正在关闭。'); if (state.busy || loginWork) throw new Error('当前任务或登录仍在进行，请等待完成或取消。'); };
  function locked(fn) {
    requireIdle(); state.busy = true; emit();
    shortWork = Promise.resolve().then(fn).finally(async () => { state.busy = false; await save(); });
    return shortWork;
  }
  function background(activity, fn) {
    requireIdle();
    state.busy = true; state.activity = activity; state.error = null;
    controller = new AbortController();
    const signal = controller.signal;
    emit();
    work = Promise.resolve().then(async () => { await save(); await fn(signal); }).catch(error => {
      state.error = signal.aborted ? '任务已取消，已完成的记录已保留。' : String(error.message ?? error);
      append('assistant', state.error);
    }).finally(async () => { state.busy = false; state.activity = ''; controller = null; await save(); });
    return { ok: true };
  }
  async function projectRevision(project, entry) {
    const root = await realpath(project.path);
    const resolved = await realpath(path.resolve(root, entry));
    const rel = path.relative(root, resolved);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('执行入口必须位于所选项目中。');
    const hash = createHash('sha256').update(await readFile(resolved));
    hash.update(JSON.stringify(project.manifest ?? {}));
    return hash.digest('hex');
  }
  function validatePlan(plan) {
    if (!plan || typeof plan.title !== 'string' || typeof plan.goal !== 'string' || typeof plan.entry !== 'string' || !Array.isArray(plan.cases) || !plan.cases.length || plan.cases.length > 50 || !Array.isArray(plan.criteria) || !plan.criteria.length || plan.criteria.some(c => typeof c !== 'string')) throw new Error('方案缺少标题、目标、标准、入口或有效测试案例。');
    if (!Number.isInteger(plan.repeats) || plan.repeats < 1 || plan.repeats > 10 || plan.cases.length * plan.repeats > 300) throw new Error('本地试运行每批支持 1–300 次执行，每个 Case 重复 1–10 次。');
    if (!Number.isInteger(plan.timeoutMs) || plan.timeoutMs < MIN_TARGET_TIMEOUT_MS || plan.timeoutMs > MAX_TARGET_TIMEOUT_MS || !['rules', 'llm'].includes(plan.judge)) throw new Error('方案超时或评分方式无效。');
    const ids = new Set();
    for (const c of plan.cases) {
      if (!c || typeof c.id !== 'string' || !/^[\w-]{1,64}$/.test(c.id) || ids.has(c.id) || typeof c.name !== 'string' || typeof c.expected !== 'string' || !c.input || typeof c.input !== 'object' || Array.isArray(c.input) || JSON.stringify(c.input).length > 16000) throw new Error('案例需要唯一 ID、名称、有效输入和预期。');
      ids.add(c.id);
    }
    return { ...structuredClone(plan), id: randomUUID(), confirmed: false, createdAt: new Date().toISOString() };
  }
  async function report() {
    if (!state.run || !state.plan || !state.project || !state.run.trials.length) throw new Error('当前还没有实际执行记录。');
    state.error = null;
    const result = await createReport({ project: structuredClone(state.project), plan: structuredClone(state.plan), run: structuredClone(state.run), directory: path.join(dataDir, 'reports'), assetsRoot: path.join(appRoot, 'public') });
    if (pdfRenderer) {
      try { result.pdfUrl = await pdfRenderer({ appRoot, directory: path.join(dataDir, 'reports'), filename: result.filename }); }
      catch { state.error = 'PDF 排版未完成，HTML 报告与附录已保存，可重新生成。'; }
    }
    append('assistant', `已生成本批实测报告：${result.url}${result.pdfUrl ? `\nPDF：${result.pdfUrl}` : ''}`, 'report');
    await save();
    return result;
  }
  return {
    snapshot, events,
    async selectProject(projectPath) {
      return locked(async () => {
        const project = await inspectProject(projectPath);
        let plan = null;
        if (project.runnable) plan = validatePlan(await createFixturePlan(project));
        state.project = project; state.plan = plan; state.run = null; state.messages = []; revision = null; state.error = null;
        append('assistant', `已读取「${project.name}」，找到 ${project.files.length} 个可检查文件。${plan ? '项目提供了执行入口和测试案例，评测方案已准备好，请检查后确认。' : '可以先说明你希望改善什么，我会结合项目材料整理评测方案。当前还需要补齐可执行的评测入口。'}`, plan ? 'plan' : undefined);
        return snapshot();
      });
    },
    async example() { return this.selectProject(path.join(appRoot, 'examples', 'customer-service')); },
    async submitPlan(candidate) {
      await locked(async () => {
        if (!state.project) throw new Error('请先选择项目文件夹。');
        const plan = validatePlan(candidate);
        await projectRevision(state.project, plan.entry);
        state.plan = plan; state.run = null; revision = null; state.error = null;
        append('assistant', '评测方案已更新，请检查目标、标准、案例和运行次数后确认。', 'plan');
      });
      return snapshot();
    },
    async configure(settings) { return locked(async () => { await models.configure(settings); state.model = await models.status(); return state.model; }); },
    async login() {
      requireIdle();
      if (loginWork) throw new Error('登录已在进行中，请完成浏览器授权或取消后重试。');
      state.error = null; state.activity = '等待 ChatGPT 登录授权…'; emit();
      let resolveUrl, rejectUrl;
      const urlPromise = new Promise((resolve, reject) => { resolveUrl = resolve; rejectUrl = reject; });
      let receivedUrl = false;
      const timer = setTimeout(() => { if (!receivedUrl) { models.cancelLogin(); rejectUrl(new Error('未能打开登录流程，请稍后重试。')); } }, 20000);
      loginWork = Promise.resolve().then(() => models.login({ onUrl: url => { receivedUrl = true; clearTimeout(timer); resolveUrl({ url }); }, onPrompt: prompt => { state.activity = typeof prompt === 'string' ? prompt : '等待浏览器授权；自动回调失败时可粘贴回调地址。'; emit(); } })).then(async () => { state.model = await models.status(); state.error = null; append('assistant', 'ChatGPT 登录已完成。发送目标描述后，可以验证当前模型是否可用。'); await save(); }).catch(error => { rejectUrl(error); state.error = String(error.message ?? error); emit(); }).finally(() => { clearTimeout(timer); loginWork = null; state.activity = ''; emit(); });
      return urlPromise;
    },
    async submitLoginCode(code) { if (typeof code !== 'string' || code.length > 8192) throw new Error('回调地址无效。'); return models.submitLoginCode(code); },
    async cancelLogin() { models.cancelLogin(); state.activity = ''; emit(); return { ok: true }; },
    async message(text) {
      requireIdle();
      if (typeof text !== 'string' || !text.trim() || text.length > 16000) throw new Error('请输入 1–16000 字的目标或问题。');
      append('user', text.trim());
      if (/^(?:请)?(?:生成|导出)(?:本轮|本批|当前)?(?:评测)?报告[。！!]?$/u.test(text.trim()) || text.trim() === '/report') return locked(report);
      if (/^(?:请)?重试(?:未完成的?|失败的?)?(?:模型)?(?:评分|打分)[。！!]?$/u.test(text.trim())) return this.retryGrading(state.run?.id);
      return background('正在阅读材料并整理评测要求…', async signal => {
        state.model = await models.status();
        if (!state.model.authenticated) { append('assistant', '请先连接模型或使用 ChatGPT 登录。也可以先运行内置客服测试项目，检查执行、状态隔离和报告链路。'); return; }
        const answer = await models.chat({ project: state.project, plan: state.plan, run: state.run ? structuredClone(state.run) : null, messages: state.messages.slice(0, -1), text: text.trim(), signal, onDelta: text => events.emit('event', { type: 'delta', text }), onPlan: async candidate => {
          if (!state.project) throw new Error('请先选择项目文件夹。');
          const plan = validatePlan(candidate);
          await projectRevision(state.project, plan.entry);
          state.plan = plan; state.run = null; revision = null;
        } });
        append('assistant', answer || '本轮处理完成，请查看方案与项目资料。', state.plan && !state.plan.confirmed ? 'plan' : undefined);
      });
    },
    async confirm(planId) {
      return locked(async () => {
        if (!state.plan || state.plan.id !== planId || !state.project) throw new Error('方案已经变化，请重新查看当前方案。');
        revision = await projectRevision(state.project, state.plan.entry);
        state.plan.confirmed = true;
        append('assistant', '评测方案已确认。点击「开始评测」将执行当前入口与案例。');
        return { ok: true };
      });
    },
    async start(planId) {
      requireIdle();
      if (!state.project || !state.plan?.confirmed || state.plan.id !== planId) throw new Error('请先确认当前评测方案。');
      // Lock before any asynchronous validation to prevent concurrent launches.
      const project = structuredClone(state.project), plan = structuredClone(state.plan);
      return background('正在初始化评测批次…', async signal => {
        if (revision !== await projectRevision(await inspectProject(project.path), plan.entry)) throw new Error('项目入口或执行配置已经变化，请重新选择项目并确认方案。');
        const modelStatus = plan.judge === 'llm' ? await models.status() : null;
        if (modelStatus && !modelStatus.authenticated) throw new Error('本方案需要 LLM 打分，请先连接模型。');
        const judgeInfo = modelStatus ? { provider: modelStatus.provider, model: modelStatus.model, authMode: modelStatus.authMode } : undefined;
        const directory = path.join(dataDir, 'runs', randomUUID());
        await mkdir(directory, { recursive: true });
        await writeJson(path.join(directory, 'project.json'), project);
        state.run = null;
        const result = await runner({ project, plan, directory, signal, judgeInfo, judge: plan.judge === 'llm' ? args => models.judge({ ...args, criteria: plan.criteria }) : undefined, onStart: async run => { state.run = structuredClone(run); await save(); }, onProgress: async (progress, run) => {
          state.run = structuredClone(run);
          state.activity = `${progress.phase === 'grading' ? '正在评分' : '正在执行'} ${progress.caseId} · 第 ${progress.trial} 次（已完成 ${progress.completed}/${progress.total}）`;
          await save();
        }, onTrial: async (trial, run) => {
          state.run = structuredClone(run); state.activity = `已完成 ${run.trials.length}/${run.planned} 次执行`; await save();
        } });
        state.run = result;
        const passed = result.trials.filter(t => t.verdict === 'pass').length;
        const failed = result.trials.filter(t => t.verdict === 'fail').length;
        const gradingErrors = result.trials.filter(t => ['error', 'cancelled'].includes(t.grading?.status)).length;
        append('assistant', `本批${result.status === 'completed' ? '执行完成' : '已停止'}：记录 ${result.trials.length}/${result.planned} 次执行，${passed} 次通过，${failed} 次发现问题。${gradingErrors ? `${gradingErrors} 次模型评分未完成，可仅重试评分。` : ''}其他执行的错误与证据不足单独保留。可以批量复核，或让我生成评测报告。`);
      });
    },
    async retryGrading(runId) {
      requireIdle();
      if (!state.run || state.run.id !== runId || !state.plan || state.run.planId !== state.plan.id || state.plan.judge !== 'llm') throw new Error('当前没有可重试评分的模型评测批次。');
      const successful = new Set((state.run.rechecks ?? []).filter(r => r.source === 'judge-retry' && r.gradingStatus === 'completed').map(r => r.trialId));
      const trials = state.run.trials.filter(t => t.status === 'completed' && t.output && ['error', 'cancelled'].includes(t.grading?.status) && !successful.has(t.id));
      if (!trials.length) throw new Error('当前没有未完成的模型评分。');
      return background('正在重试已有证据的模型评分…', async signal => {
        const status = await models.status();
        if (!status.authenticated) throw new Error('请先连接原评分模型，再重试评分。');
        if (!state.run.judge || state.run.judge.provider !== status.provider || state.run.judge.model !== status.model) throw new Error('请切换回本批原评分模型再重试，以保持评分条件一致。');
        const judge = { provider: status.provider, model: status.model, authMode: status.authMode };
        const records = [], filename = path.join(state.run.directory, `grading-retry-${randomUUID()}.json`);
        for (const trial of trials) {
          if (signal.aborted) break;
          state.activity = `正在重试评分 ${trial.caseId} · 第 ${trial.trial} 次（${records.length}/${trials.length}）`;
          emit();
          let result, gradingStatus = 'completed';
          try {
            const evalCase = state.plan.cases.find(c => c.id === trial.caseId);
            const scored = await models.judge({ case: evalCase, output: structuredClone(trial.output), trace: structuredClone(trial.trace), criteria: state.plan.criteria, signal });
            if (!['pass', 'fail', 'pending'].includes(scored?.verdict) || typeof scored.reason !== 'string' || !scored.reason.trim()) throw new Error('模型评分格式无效。');
            const objective = trial.ruleResult ?? scoreRules(state.project, evalCase, trial.output);
            result = objective.verdict === 'fail' ? { verdict: 'fail', reason: `${objective.reason}；模型评分：${scored.reason}` } : scored;
          } catch {
            gradingStatus = signal.aborted ? 'cancelled' : 'error';
            result = { verdict: 'pending', reason: signal.aborted ? '评分重试已取消，原始证据保留。' : '评分重试未完成，修复模型连接后可再次重试。' };
          }
          const record = { trialId: trial.id, caseId: trial.caseId, checkedAt: new Date().toISOString(), source: 'judge-retry', gradingStatus, judge, ...result };
          records.push(record);
          state.run.rechecks = [...(state.run.rechecks ?? []), record];
          await writeJson(path.join(state.run.directory, 'run.json'), state.run);
          await writeJson(filename, records);
          await save();
          if (gradingStatus !== 'completed') break;
        }
        append('assistant', `已完成 ${records.filter(r => r.gradingStatus === 'completed').length}/${trials.length} 次评分重试。使用原有执行证据，未重新运行目标；原始评分和人工判断保留。`);
      });
    },
    async cancel() { controller?.abort(); await models.cancelLogin(); return { ok: true }; },
    async review(decisions, expectedRunId) {
      requireIdle();
      if (!state.run || !state.plan || state.run.planId !== state.plan.id || !decisions || typeof decisions !== 'object' || Array.isArray(decisions)) throw new Error('当前没有可复核的执行结果。');
      if (expectedRunId !== undefined && state.run.id !== expectedRunId) throw new Error('评测批次已经变化，请重新查看当前执行结果。');
      const known = new Set(state.run.trials.map(t => t.caseId));
      for (const [id, decision] of Object.entries(decisions)) if (!known.has(id) || !['issue', 'clear', 'recheck'].includes(decision)) throw new Error('存在无效的案例或复核结论。');
      const submittedDecisions = structuredClone(decisions);
      return background('正在保存复核结论并检查证据…', async signal => {
      state.run.reviews = { ...state.run.reviews, ...submittedDecisions };
      for (const id of known) if (!state.run.reviews[id]) state.run.reviews[id] = 'recheck';
      const pendingIds = [...known].filter(id => state.run.reviews[id] === 'recheck');
      await writeJson(path.join(state.run.directory, 'run.json'), state.run);
      append('assistant', `批量判断已保存；${pendingIds.length} 项待核查。原始评分保留，明确的人工判断不会被自动覆盖。`);
      if (!pendingIds.length) return;
        const records = [];
        for (const t of state.run.trials.filter(t => pendingIds.includes(t.caseId))) {
          if (signal.aborted) break;
          if (!t.output || t.status !== 'completed') { records.push({ trialId: t.id, caseId: t.caseId, checkedAt: new Date().toISOString(), verdict: 'pending', reason: '缺少完整执行证据。' }); continue; }
          const evalCase = state.plan.cases.find(c => c.id === t.caseId);
          let result;
          try {
            const objective = scoreRules(state.project, evalCase, t.output);
            result = state.plan.judge === 'llm' && objective.verdict !== 'fail' ? await models.judge({ case: evalCase, output: t.output, trace: t.trace, criteria: state.plan.criteria, signal }) : objective;
          }
          catch { result = { verdict: 'pending', reason: '自动核查未能得到有效判断，保留待定。' }; }
          records.push({ trialId: t.id, caseId: t.caseId, checkedAt: new Date().toISOString(), source: 'review', ...result });
        }
        state.run.rechecks = [...(state.run.rechecks ?? []), ...records];
        await writeJson(path.join(state.run.directory, 'run.json'), state.run);
        await writeJson(path.join(state.run.directory, `recheck-${randomUUID()}.json`), records);
        const counts = { fail: 0, pass: 0, pending: 0 };
        for (const r of records) counts[r.verdict in counts ? r.verdict : 'pending']++;
        append('assistant', `按保存的执行证据完成 ${records.length} 次自动核查：${counts.fail} 次确认问题，${counts.pass} 次未发现问题，${counts.pending} 次仍待定。没有重新调用被测项目；原始评分与人工判断均保留。`);
      });
    },
    async report() { return locked(report); },
    async idle() { await work; },
    async dispose() { closing = true; controller?.abort(); models.cancelLogin(); await Promise.allSettled([work, shortWork, loginWork]); await models.dispose(); await save(); events.removeAllListeners(); },
  };
}
