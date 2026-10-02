import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowDownToLine, ArrowUp, Check, CheckCheck, ChevronDown, ChevronRight, Circle,
  FileText, FolderOpen, Link2, LoaderCircle, MessageSquare, PanelRightClose,
  PanelRightOpen, Play, RefreshCw, Settings2, Square, X,
} from 'lucide-react';
import type { AppState, ChatMessage, EvalRun, HumanDecision, ModelStatus, Recheck, Trial } from '../shared/contracts';
import { getRuntimeState, postRuntime, runtimeFileUrl, subscribeRuntime } from '../lib/runtimeClient';
import './live.css';

type DetailTab = 'project' | 'plan' | 'results' | 'report';
type ReportResponse = { url: string; filename: string; pdfUrl?: string };
type ReportFile = ReportResponse & { runId: string };
const decisionLabels: Record<HumanDecision, string> = { issue: '确认有问题', clear: '确认无问题', recheck: '交给 Agent 核查' };
const verdictLabels = { pass: '通过', fail: '未通过', pending: '待定', error: '异常' };
const gradingLabels = { completed: '已完成', error: '评分失败', cancelled: '评分已停止', not_run: '未评分' };
const runLabels: Record<EvalRun['status'], string> = {
  running: '正在评测', completed: '评测完成', cancelled: '已停止', interrupted: '运行中断', failed: '运行失败',
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '操作未完成，请重试。';
}

function reportLinksFromMessage(text: string, latest: ReportFile | null): Pick<ReportResponse, 'url' | 'pdfUrl'> | null {
  const htmlPath = text.match(/\/api\/files\/[A-Za-z0-9][A-Za-z0-9._-]*\.html\b/)?.[0];
  if (!htmlPath) return null;
  try {
    const url = runtimeFileUrl(htmlPath);
    const pdfPath = text.match(/\/api\/files\/[A-Za-z0-9][A-Za-z0-9._-]*\.pdf\b/)?.[0];
    return { url, ...(pdfPath ? { pdfUrl: runtimeFileUrl(pdfPath) } : latest?.url === url && latest.pdfUrl ? { pdfUrl: latest.pdfUrl } : {}) };
  } catch { return null; }
}

function savedReport(messages: ChatMessage[], runId?: string): ReportFile | null {
  if (!runId) return null;
  for (const message of [...messages].reverse()) {
    if (message.artifact !== 'report') continue;
    const links = reportLinksFromMessage(message.text, null);
    if (!links) continue;
    const filename = new URL(links.url).pathname.split('/').at(-1) ?? '';
    if (filename.startsWith(`${runId}-`) && filename.endsWith('-report.html')) return { ...links, filename, runId };
  }
  return null;
}

function completedRetry(check: Recheck) {
  return check.source === 'judge-retry' && (check.gradingStatus === 'completed' || (!check.gradingStatus && ['pass', 'fail', 'pending'].includes(check.verdict)));
}

function ModelConnection({ model, disabled, onClose, onSave, onLogin, authUrl, loginStatus, onCancelLogin, onSubmitCode }: {
  model: ModelStatus; disabled: boolean; onClose: () => void;
  onSave: (settings: { provider: string; model: string; baseUrl?: string; apiKey?: string }) => Promise<boolean>;
  onLogin: () => void; authUrl: string | null; loginStatus: 'idle' | 'pending' | 'failed'; onCancelLogin: () => void;
  onSubmitCode: (code: string) => Promise<boolean>;
}) {
  const [method, setMethod] = useState<'subscription' | 'api'>(model.authMode === 'api-key' ? 'api' : 'subscription');
  const [provider, setProvider] = useState(model.provider || 'openai');
  const [modelName, setModelName] = useState(model.model || '');
  const [baseUrl, setBaseUrl] = useState(model.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [callbackCode, setCallbackCode] = useState('');
  const [callbackSubmitted, setCallbackSubmitted] = useState(false);
  useEffect(() => {
    setProvider(model.provider || 'openai');
    setModelName(model.model || '');
    setBaseUrl(model.baseUrl ?? '');
  }, [model.provider, model.model, model.baseUrl]);
  useEffect(() => { if (model.authenticated && model.authMode === 'subscription') setCallbackCode(''); }, [model.authenticated, model.authMode]);
  async function save(event: FormEvent) {
    event.preventDefault();
    const settings = { provider: method === 'subscription' ? 'openai' : baseUrl.trim() ? 'openai-compatible' : provider.trim(), model: modelName.trim(), ...(baseUrl.trim() && method === 'api' ? { baseUrl: baseUrl.trim() } : {}), ...(apiKey && method === 'api' ? { apiKey } : {}) };
    setApiKey('');
    if (await onSave(settings)) onClose();
  }
  return <section className="live-connect" aria-label="连接模型">
    <div className="live-card-heading"><div><span className="live-overline">MODEL CONNECTION</span><h2>连接你的模型</h2></div><button className="live-icon" aria-label="关闭模型配置" onClick={onClose}><X size={17} /></button></div>
    <div className="live-methods" role="group" aria-label="连接方式">
      <button className={method === 'subscription' ? 'active' : ''} aria-pressed={method === 'subscription'} onClick={() => setMethod('subscription')}>ChatGPT 订阅</button>
      <button className={method === 'api' ? 'active' : ''} aria-pressed={method === 'api'} onClick={() => setMethod('api')}>模型 API</button>
    </div>
    {method === 'subscription' ? <div className="live-subscription">
      <p>登录 ChatGPT 并授权 EvalPi 使用订阅额度。可用模型与额度以你的账户权限为准。</p>
      {model.authenticated && model.authMode === 'subscription' ? <div className="live-success"><Check size={15} /> 订阅已连接</div> : <button className="live-primary" disabled={disabled || loginStatus === 'pending'} onClick={() => { setCallbackSubmitted(false); onLogin(); }}><Link2 size={15} />{loginStatus === 'failed' ? '重新使用 ChatGPT 登录' : '使用 ChatGPT 订阅登录'}</button>}
      {authUrl && <div className="live-auth-pending"><p>请在浏览器中完成登录，连接状态会自动更新。</p><a href={authUrl} target="_blank" rel="noreferrer">继续打开登录页面 ↗</a><button className="live-text" onClick={onCancelLogin}>取消登录</button></div>}
      {loginStatus !== 'idle' && !(model.authenticated && model.authMode === 'subscription') && <details className="live-auth-fallback"><summary>浏览器登录后没有自动连接？</summary><p>{loginStatus === 'failed' ? '登录流程已结束，请先重新发起登录。再次遇到回调问题时，可在这里提交浏览器完整回调地址。' : '可将浏览器的完整回调地址粘贴到这里。内容仅交给本机登录流程，不进入聊天记录。'}</p><form onSubmit={async event => { event.preventDefault(); if (await onSubmitCode(callbackCode.trim())) { setCallbackCode(''); setCallbackSubmitted(true); } }}><label>登录回调地址<input type="password" value={callbackCode} onChange={event => { setCallbackCode(event.target.value); setCallbackSubmitted(false); }} autoComplete="new-password" spellCheck={false} maxLength={8192} placeholder="粘贴完整回调地址" /></label><button className="live-secondary" disabled={disabled || loginStatus !== 'pending' || !callbackCode.trim()} type="submit">提交回调地址</button></form>{callbackSubmitted && <p role="status">回调地址已提交，正在等待登录验证。</p>}</details>}
    </div> : null}
    {(method === 'api' || (model.authenticated && model.authMode === 'subscription')) && <form onSubmit={save} className="live-model-form">
      {method === 'api' && <><label>服务商<input value={baseUrl.trim() ? 'openai-compatible' : provider} onChange={event => setProvider(event.target.value)} placeholder="openai" required disabled={Boolean(baseUrl.trim())} autoComplete="off" /></label><label>自定义 API 地址 <span>官方服务可留空；填写后使用 OpenAI 兼容协议</span><input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://your-provider.com/v1" type="url" autoComplete="off" /></label>{baseUrl.trim() && <p className="live-model-help">自定义地址需要单独配置 API Key。更换地址时请重新输入凭据；ChatGPT 订阅凭据仅用于原生 OpenAI 服务。</p>}</>}
      <label>模型名称<input value={modelName} onChange={event => setModelName(event.target.value)} list="live-model-options" placeholder="选择或填写模型名称" required autoComplete="off" /><datalist id="live-model-options">{model.availableModels.map(name => <option key={name} value={name} />)}</datalist></label>
      {method === 'api' && <label>API Key <span>{model.authenticated ? '留空可沿用本机凭据' : '仅用于本机连接'}</span><input type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} autoComplete="new-password" placeholder="输入 API Key" /></label>}
      <button className="live-primary" type="submit" disabled={disabled || !modelName.trim() || (method === 'api' && !provider.trim())}>保存模型配置</button>
    </form>}
  </section>;
}

function TrialEvidence({ trial, recheck, gradingRetry, modelRun }: { trial: Trial; recheck?: Recheck; gradingRetry?: Recheck; modelRun: boolean }) {
  const grading = modelRun || trial.judgeSource === 'llm' ? trial.grading : undefined;
  const checks = [gradingRetry, recheck].filter((check): check is Recheck => Boolean(check));
  return <details className="live-trial"><summary><span>第 {trial.trial} 次</span><span className={`live-verdict ${trial.verdict}`}>{verdictLabels[trial.verdict]}</span>{grading && grading.status !== 'completed' && grading.status !== 'not_run' && <span className="live-grading-alert">{gradingLabels[grading.status]}</span>}{gradingRetry && completedRetry(gradingRetry) && <span className="live-recheck-summary">评分已补齐</span>}<span className="live-trial-duration">执行 {(trial.durationMs / 1000).toFixed(1)}s{grading?.durationMs !== undefined ? ` · 评分 ${(grading.durationMs / 1000).toFixed(1)}s` : ''}</span><ChevronDown size={13} /></summary>
    <div className="live-trial-body">{checks.map(check => <section className="live-recheck-evidence" key={`${check.source}-${check.checkedAt}`}><h4>{check.source === 'judge-retry' ? '最近一次评分重试' : '最近一次自动核查'} <span className={`live-verdict ${check.verdict}`}>{check.gradingStatus === 'error' ? '评分失败' : check.gradingStatus === 'cancelled' ? '评分已停止' : verdictLabels[check.verdict]}</span></h4><p>{check.reason}</p>{check.judge && <small>{check.judge.model} · {check.judge.provider}<br /></small>}<small>{check.checkedAt.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')} · 使用已有执行证据</small></section>)}<h4>原始判定</h4><p>{trial.reason || trial.error || '暂无判定说明。'}</p>
      {trial.ruleResult && <section className="live-grading-evidence"><h4>业务规则 <span className={`live-verdict ${trial.ruleResult.verdict}`}>{verdictLabels[trial.ruleResult.verdict]}</span></h4><p>{trial.ruleResult.reason}</p></section>}
      {grading && <section className="live-grading-evidence"><h4>原始模型评分 <span className={`live-verdict ${grading.status === 'completed' ? grading.verdict : grading.status === 'error' ? 'error' : 'pending'}`}>{grading.status === 'completed' && grading.verdict ? verdictLabels[grading.verdict] : gradingLabels[grading.status]}</span></h4><p>{grading.reason || (grading.status === 'not_run' ? '本次未调用模型评分。' : '模型未返回有效评分，原始执行证据已保留。')}</p>{trial.ruleResult?.verdict === 'fail' && <p className="live-grading-note">规则已确认业务失败，模型评分与重试结果单独保留。</p>}</section>}
      <dl><div><dt>判定来源</dt><dd>{trial.judgeSource === 'llm' ? trial.ruleResult ? '业务规则 + 模型评分' : '模型评分' : trial.judgeSource === 'rules' ? '规则验证' : '未评分'}</dd></div><div><dt>执行耗时</dt><dd>{(trial.durationMs / 1000).toFixed(2)} 秒</dd></div>{grading?.durationMs !== undefined && <div><dt>评分耗时</dt><dd>{(grading.durationMs / 1000).toFixed(2)} 秒</dd></div>}<div><dt>独立会话</dt><dd>{trial.sessionId}</dd></div></dl>
      {trial.output && <><h4>实际输出</h4><pre>{JSON.stringify(trial.output, null, 2)}</pre></>}
      <h4>运行 Trace · {trial.trace.length} 条</h4><pre>{trial.trace.length ? JSON.stringify(trial.trace, null, 2) : '当前运行未提供 Trace。'}</pre>
    </div>
  </details>;
}

export default function LiveWorkspace() {
  const [state, setState] = useState<AppState | null>(null);
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [localError, setLocalError] = useState<string | null>(null);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [stream, setStream] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [showPath, setShowPath] = useState(false);
  const [showModel, setShowModel] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [loginStatus, setLoginStatus] = useState<'idle' | 'pending' | 'failed'>('idle');
  const [tab, setTab] = useState<DetailTab>('project');
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth >= 1000);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [report, setReport] = useState<ReportFile | null>(null);
  const [reviewNotice, setReviewNotice] = useState('');
  const [retry, setRetry] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const shouldFollowRef = useRef(true);
  const stateRef = useRef<AppState | null>(null);
  const restoredNavigationRef = useRef(false);
  const pendingRef = useRef(false);
  const disabled = Boolean(pending || state?.busy || connection !== 'connected');
  const run = state?.run;
  const plan = state?.plan;
  const latestPlanMessageId = state?.messages.filter(message => message.artifact === 'plan').at(-1)?.id;
  const currentReport = report && report.runId === run?.id ? report : null;

  const acceptState = useCallback((next: AppState) => {
    stateRef.current = next;
    setState(next);
    setStream('');
    const restoredReport = savedReport(next.messages, next.run?.id);
    setReport(previous => restoredReport ?? (previous?.runId === next.run?.id ? previous : null));
    if (!restoredNavigationRef.current) {
      restoredNavigationRef.current = true;
      if (restoredReport) setTab('report');
      else if (next.run) setTab('results');
      else if (next.plan) setTab('plan');
    }
    if (next.model.authenticated && next.model.authMode === 'subscription') { setAuthUrl(null); setLoginStatus('idle'); }
    else if (next.error && /登录|授权|回调/.test(next.error)) {
      setLoginStatus(previous => previous === 'pending' ? 'failed' : previous);
      setAuthUrl(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let revision = 0;
    setConnection('connecting');
    getRuntimeState().then(next => {
      if (!cancelled && revision === 0) { acceptState(next); setLocalError(null); }
    }).catch(error => {
      if (!cancelled && revision === 0) { setLocalError(errorMessage(error)); setConnection('disconnected'); }
    });
    const unsubscribe = subscribeRuntime({
      onConnected: () => {
        if (!cancelled) {
          setConnection('connected');
          // Reconnection retrieves authoritative state even if events were missed.
          const captured = revision;
          getRuntimeState().then(next => { if (!cancelled && captured === revision) acceptState(next); }).catch(error => { if (!cancelled) setLocalError(errorMessage(error)); });
        }
      },
      onDisconnected: () => { if (!cancelled) setConnection('disconnected'); },
      onEvent: event => {
        if (cancelled) return;
        if (event.type === 'state' && event.state) { revision++; acceptState(event.state); setConnection('connected'); }
        if (event.type === 'delta' && event.text) setStream(text => text + event.text);
      },
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [acceptState, retry]);

  useEffect(() => { if (shouldFollowRef.current) bottomRef.current?.scrollIntoView({ block: 'end' }); }, [state?.messages.length, stream, showModel, showPath]);
  useEffect(() => { setSelected(new Set()); setReviewNotice(''); }, [run?.id]);

  async function action<T = { ok: boolean }>(label: string, path: string, body: unknown = {}): Promise<T | null> {
    if (pendingRef.current) return null;
    pendingRef.current = true;
    setPending(label); setLocalError(null); setDismissedError(null);
    try {
      const result = await postRuntime<T>(path, body);
      try { acceptState(await getRuntimeState()); } catch { setConnection('disconnected'); }
      return result;
    } catch (error) { setLocalError(errorMessage(error)); return null; }
    finally { pendingRef.current = false; setPending(null); }
  }

  async function chooseProject() {
    if (!window.evalpi) { setShowPath(value => !value); return; }
    try { const path = await window.evalpi.chooseFolder(); if (path && await action('正在读取项目', '/project', { path })) { setTab('project'); setPanelOpen(true); } }
    catch (error) { setLocalError(errorMessage(error)); }
  }
  async function loadPath(event: FormEvent) {
    event.preventDefault();
    if (await action('正在读取项目', '/project', { path: projectPath.trim() })) { setShowPath(false); setProjectPath(''); setTab('project'); setPanelOpen(true); }
  }
  async function send(event?: FormEvent) {
    event?.preventDefault();
    if (!input.trim() || disabled) return;
    const text = input.trim(); setInput(''); shouldFollowRef.current = true;
    const runId = stateRef.current?.run?.id;
    const result = await action<ReportResponse | { ok: boolean }>('正在发送', '/message', { text });
    if (!result) setInput(text);
    else if ('url' in result && runId) receiveReport(result, runId);
  }
  async function login() {
    setLoginStatus('pending'); setAuthUrl(null);
    const response = await action<{ url?: string }>('正在启动登录', '/auth/login');
    if (response?.url) {
      try {
        const url = new URL(response.url);
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('登录地址格式无效。');
        setAuthUrl(url.href);
        if (window.evalpi) await window.evalpi.openExternal(url.href);
        else window.open(url.href, '_blank', 'noopener,noreferrer');
      } catch (error) { setLoginStatus('failed'); setLocalError(errorMessage(error)); }
    } else if (!response) setLoginStatus('failed');
  }
  async function review(decision: HumanDecision) {
    const ids = [...selected];
    if (await action('正在保存复核', '/review', { decisions: Object.fromEntries(ids.map(id => [id, decision])) })) {
      setSelected(new Set()); setReviewNotice(`已提交 ${ids.length} 项：${decisionLabels[decision]}。`);
    }
  }
  function receiveReport(result: ReportResponse, runId: string) {
    try { setReport({ ...result, url: runtimeFileUrl(result.url), ...(result.pdfUrl ? { pdfUrl: runtimeFileUrl(result.pdfUrl) } : {}), runId }); setTab('report'); setPanelOpen(true); }
    catch (error) { setLocalError(errorMessage(error)); }
  }
  async function createReport() {
    const runId = stateRef.current?.run?.id;
    const result = await action<ReportResponse>('正在生成报告', '/report');
    if (result && runId) receiveReport(result, runId);
  }
  function selectCase(id: string) { setSelected(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  function openDetail(next: DetailTab) { setTab(next); setPanelOpen(true); }
  const caseIds = [...new Set(run?.trials.map(trial => trial.caseId) ?? [])];
  const counts = run?.trials.reduce((totals, trial) => ({ ...totals, [trial.verdict]: totals[trial.verdict] + 1 }), { pass: 0, fail: 0, pending: 0, error: 0 });
  const latestRechecks = new Map((run?.rechecks ?? []).filter(check => check.source !== 'judge-retry').map(check => [check.trialId, check]));
  const gradingRetries = new Map((run?.rechecks ?? []).filter(check => check.source === 'judge-retry').map(check => [check.trialId, check]));
  const retriedTrialIds = new Set((run?.rechecks ?? []).filter(completedRetry).map(check => check.trialId));
  const gradingCompleted = run?.trials.filter(trial => trial.judgeSource === 'llm' && trial.grading?.status === 'completed').length ?? 0;
  const gradingFailed = run?.trials.filter(trial => trial.grading?.status === 'error').length ?? 0;
  const gradingCancelled = run?.trials.filter(trial => trial.grading?.status === 'cancelled').length ?? 0;
  const retryableCount = run?.trials.filter(trial => ['error', 'cancelled'].includes(trial.grading?.status ?? '') && !retriedTrialIds.has(trial.id)).length ?? 0;
  const lastError = localError || state?.error;
  const error = lastError !== dismissedError ? lastError : null;

  return <div className={`live-shell ${panelOpen ? 'with-detail' : ''}`}>
    <aside className="live-nav" aria-label="工作区导航">
      <a className="live-brand" href="/" aria-label="EvalPi 首页"><img src="/evalpi.svg" alt="" />EvalPi<span>.</span></a>
      <div className="live-nav-caption">当前工作区</div>
      <button className="live-project-nav" onClick={() => openDetail('project')}><FolderOpen size={16} /><span>{state?.project?.name || '未选择项目'}</span></button>
      <div className="live-journey">
        {(['project', 'plan', 'results', 'report'] as const).map((step, index) => {
          const ready = step === 'project' ? Boolean(state?.project) : step === 'plan' ? Boolean(plan?.confirmed) : step === 'results' ? run?.status === 'completed' : Boolean(currentReport);
          return <button key={step} className={tab === step && panelOpen ? 'active' : ''} onClick={() => openDetail(step)}>{ready ? <Check size={13} /> : <span>{String(index + 1).padStart(2, '0')}</span>}{['理解项目', '确认方案', '评测与复核', '评测报告'][index]}</button>;
        })}
      </div>
      <div className="live-nav-bottom"><button onClick={() => { setShowModel(true); shouldFollowRef.current = true; }}><Settings2 size={15} /><span>{state?.model.authenticated ? state.model.model : '连接模型'}</span></button><div className={`live-connection ${connection}`}><span />{connection === 'connected' ? '本机运行服务已连接' : connection === 'connecting' ? '正在连接本机服务' : '本机服务连接中断'}</div><a href="/demo">查看界面演示 ↗</a></div>
    </aside>

    <main className="live-main">
      <header className="live-header"><div><span className="live-overline">EVALUATION WORKSPACE</span><h1>{state?.project?.name || '从一个真实项目开始'}</h1></div><button className="live-icon" aria-label={panelOpen ? '收起详情' : '展开详情'} aria-expanded={panelOpen} onClick={() => setPanelOpen(value => !value)}>{panelOpen ? <PanelRightClose size={19} /> : <PanelRightOpen size={19} />}</button></header>
      {connection === 'disconnected' && <div className="live-connection-banner" role="status"><span>运行服务连接已断开，正在自动重连。页面显示最后一次收到的状态。</span><button onClick={() => setRetry(value => value + 1)}><RefreshCw size={13} />重试</button></div>}
      <div className="live-chat" onScroll={event => { const node = event.currentTarget; shouldFollowRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100; }}>
        <div className="live-chat-inner">
          {!state?.messages.length && <section className="live-welcome"><span className="live-overline">UNDERSTAND. EVALUATE. IMPROVE.</span><h2>让每一次改进，<br />都有据可循。</h2><p>选择你的 Agent 或 Workflow 项目，告诉我你希望它做得更好的地方。我们先确定评测方案，再开始运行。</p><div className="live-welcome-actions"><button className="live-primary" disabled={disabled} onClick={chooseProject}><FolderOpen size={16} />选择本地项目</button><button className="live-secondary" disabled={disabled} onClick={async () => { if (await action('正在载入客服示例', '/example')) { openDetail('plan'); } }}>试跑客服示例<ChevronRight size={14} /></button></div><p className="live-welcome-note">客服示例可先验证执行与业务状态；连接模型后，可继续用对话理解项目。</p></section>}
          {state?.messages.map(message => {
            const reportLinks = message.artifact === 'report' ? reportLinksFromMessage(message.text, report) : null;
            return <article key={message.id} className={`live-message ${message.role}`}>
              <div className="live-message-author">{message.role === 'user' ? '你' : <><span className="live-agent-mark">π</span>EvalPi</>}</div>
              <div className="live-message-text">{message.artifact === 'report' ? '报告已生成，包含本批结果与对应证据。' : message.text}</div>
              {message.artifact === 'plan' && message.id === latestPlanMessageId && plan && <button className="live-artifact" onClick={() => openDetail('plan')}><FileText size={17} /><span><strong>{plan.title}</strong><small>{plan.cases.length} 个案例 · 每例 {plan.repeats} 次 · {plan.confirmed ? '已确认' : '待确认'}</small></span><ChevronRight size={15} /></button>}
              {reportLinks && <div className="live-report-index">
                <h3>本轮评测报告</h3>
                <a className="live-report-link" href={reportLinks.url} target="_blank" rel="noreferrer" onClick={event => { if (currentReport?.url === reportLinks.url) { event.preventDefault(); openDetail('report'); } }}><FileText size={16} /><span>HTML · 阅读报告</span><ChevronRight size={15} /></a>
                {reportLinks.pdfUrl && <a className="live-report-link" href={reportLinks.pdfUrl} target="_blank" rel="noreferrer"><FileText size={16} /><span>PDF · 评测报告.pdf</span><ArrowDownToLine size={15} /></a>}
              </div>}
            </article>;
          })}
          {stream && <article className="live-message assistant"><div className="live-message-author"><span className="live-agent-mark">π</span>EvalPi</div><div className="live-message-text">{stream}</div></article>}
          {showPath && <form className="live-connect live-path-form" onSubmit={loadPath}><div className="live-card-heading"><h2>读取本地项目</h2><button type="button" className="live-icon" aria-label="关闭路径输入" onClick={() => setShowPath(false)}><X size={16} /></button></div><label>项目文件夹的完整路径<input value={projectPath} onChange={event => setProjectPath(event.target.value)} placeholder="C:\Projects\customer-service-agent" autoFocus required /></label><p>浏览器预览通过本机服务读取路径。桌面应用可直接打开文件夹选择器。</p><button className="live-primary" disabled={disabled || !projectPath.trim()} type="submit">读取项目<ChevronRight size={14} /></button></form>}
          {showModel && state && <ModelConnection model={state.model} disabled={Boolean(pending) || connection !== 'connected'} onClose={() => setShowModel(false)} onSave={async settings => Boolean(await action('正在保存模型', '/model', settings))} onLogin={login} authUrl={authUrl} loginStatus={loginStatus} onCancelLogin={async () => { if (await action('正在取消登录', '/auth/cancel')) { setAuthUrl(null); setLoginStatus('idle'); } }} onSubmitCode={async code => Boolean(await action('正在验证登录回调', '/auth/code', { code }))} />}
          {error && <div className="live-error" role="alert"><span>{error}</span><button aria-label="关闭错误提示" className="live-icon" onClick={() => { setDismissedError(error); setLocalError(null); }}><X size={15} /></button></div>}
          {currentReport && !state?.messages.some(message => message.artifact === 'report' && reportLinksFromMessage(message.text, report)?.url === currentReport.url) && <div className="live-report-index"><h3>本轮评测报告</h3><a className="live-report-link" href={currentReport.url} target="_blank" rel="noreferrer"><FileText size={16} /><span>评测报告 · 应用内预览</span><ChevronRight size={15} /></a>{currentReport.pdfUrl && <a className="live-report-link" href={currentReport.pdfUrl} target="_blank" rel="noreferrer"><FileText size={16} /><span>评测报告.pdf</span><ArrowDownToLine size={15} /></a>}</div>}
          {(state?.busy || pending) && <div className="live-activity" role="status"><LoaderCircle size={14} className="live-spin" /><span>{pending || state?.activity || '正在处理'}</span></div>}
          <div ref={bottomRef} />
        </div>
      </div>
      <div className="live-compose-wrap">
        {run?.status === 'running' && <div className="live-run-strip"><span><LoaderCircle size={13} className="live-spin" />已记录 {run.trials.length} / {run.planned} 次执行</span><button className="live-text" onClick={() => openDetail('results')}>查看证据<ChevronRight size={13} /></button></div>}
        <form className="live-composer" onSubmit={send}><label className="visually-hidden" htmlFor="live-chat-input">告诉 EvalPi 你的评测目标</label><textarea id="live-chat-input" ref={inputRef} value={input} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} placeholder={state?.project ? '说说你的目标，或调整本次评测标准…' : '告诉我项目在哪里，以及你想改善什么…'} rows={3} /><div className="live-compose-tools"><button type="button" className="live-icon" title="读取本地项目" aria-label="读取本地项目" disabled={disabled} onClick={chooseProject}><FolderOpen size={18} /></button><button type="button" className="live-model-chip" onClick={() => { setShowModel(value => !value); shouldFollowRef.current = true; }}><span className={state?.model.authenticated ? 'connected' : ''} />{state?.model.authenticated ? state.model.model : '连接模型'}<ChevronDown size={12} /></button>{state?.busy ? <button type="button" className="live-send" aria-label="停止当前任务" disabled={Boolean(pending) || connection !== 'connected'} onClick={() => void action('正在停止', '/cancel')}><Square size={15} /></button> : <button className="live-send" type="submit" disabled={disabled || !input.trim()} aria-label="发送消息"><ArrowUp size={19} /></button>}</div></form><div className="live-compose-hint">Enter 发送 · Shift + Enter 换行<span>评测开始前需要你确认方案</span></div>
      </div>
    </main>

    {panelOpen && <aside className={`live-detail ${tab === 'report' ? 'live-detail-report' : ''}`} aria-label="项目与评测详情"><div className="live-detail-tabs" role="tablist" aria-label="详情分类">{(['project', 'plan', 'results', 'report'] as const).map((value, index) => <button id={`live-tab-${value}`} key={value} role="tab" aria-selected={tab === value} aria-controls={`live-panel-${value}`} onClick={() => setTab(value)}>{['项目', '方案', '结果', '报告'][index]}</button>)}<button className="live-icon live-detail-close" aria-label="关闭详情" onClick={() => setPanelOpen(false)}><X size={16} /></button></div>
      <div className="live-detail-content" role="tabpanel" id={`live-panel-${tab}`} aria-labelledby={`live-tab-${tab}`}>
        {tab === 'project' && (state?.project ? <><div className="live-detail-title"><span className="live-overline">PROJECT UNDERSTANDING</span><h2>{state.project.name}</h2><p className="live-path">{state.project.path}</p></div><section className="live-detail-section"><h3>对项目的理解</h3><p className="live-preserve">{state.project.summary}</p></section><div className={`live-project-ready ${state.project.runnable ? 'ready' : ''}`}>{state.project.runnable ? <Check size={15} /> : <Circle size={15} />}<span>{state.project.runnable ? '已找到可运行的评测入口' : '尚未找到评测入口。可以继续对话分析项目，补齐运行配置后再执行。'}</span></div><section className="live-detail-section"><h3>已读取的文件 <span>{state.project.files.length}</span></h3><ul className="live-files">{state.project.files.map(file => <li key={file}><FileText size={13} /><span>{file}</span></li>)}</ul></section><button className="live-secondary" disabled={disabled} onClick={chooseProject}><FolderOpen size={14} />切换项目</button></> : <div className="live-empty"><FolderOpen size={29} /><h2>先认识你的项目</h2><p>读取本地文件夹后，这里会显示项目理解、运行入口和已读取的文件。</p><button className="live-secondary" disabled={disabled} onClick={chooseProject}>选择项目</button></div>)}
        {tab === 'plan' && (plan ? <><div className="live-detail-title"><span className="live-overline">EVALUATION PLAN</span><h2>{plan.title}</h2><p>{plan.goal}</p></div><div className="live-plan-meta"><div><strong>{plan.cases.length}</strong><span>测试案例</span></div><div><strong>{plan.repeats}</strong><span>每例重复</span></div><div><strong>{plan.cases.length * plan.repeats}</strong><span>计划执行</span></div></div><section className="live-detail-section"><h3>评测标准</h3><ol className="live-criteria">{plan.criteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ol></section><dl className="live-facts"><div><dt>打分方式</dt><dd>{plan.judge === 'rules' ? '规则验证' : '模型评分'}</dd></div><div><dt>单次超时</dt><dd>{plan.timeoutMs / 1000} 秒</dd></div><div><dt>运行入口</dt><dd>{plan.entry}</dd></div><div><dt>方案来源</dt><dd>{plan.source === 'fixture' ? '客服示例' : 'Agent 生成'}</dd></div></dl><details className="live-case-preview"><summary>查看全部 {plan.cases.length} 个案例<ChevronDown size={14} /></summary>{plan.cases.map(item => <div key={item.id}><span className="live-overline">{item.id}</span><h4>{item.name}</h4><p>{item.expected}</p><details><summary>输入数据</summary><pre>{JSON.stringify(item.input, null, 2)}</pre></details></div>)}</details><div className="live-plan-action">{plan.confirmed ? <><p><CheckCheck size={15} />方案已确认</p><button className="live-primary" disabled={disabled || !state?.project?.runnable} onClick={async () => { if (await action('正在启动评测', '/run', { planId: plan.id })) openDetail('results'); }}><Play size={15} />{run?.planId === plan.id ? '按此方案重新评测' : '开始评测'}</button></> : <><p>确认后可开始运行。需要调整时，直接在对话中说明。</p><button className="live-primary" disabled={disabled} onClick={() => void action('正在确认方案', '/plan/confirm', { planId: plan.id })}><Check size={15} />确认这份方案</button></>}</div></> : <div className="live-empty"><FileText size={29} /><h2>把目标变成可检验的方案</h2><p>选择项目并说明你的目标，Agent 会整理测试案例、评测标准和运行次数，交给你确认。</p></div>)}
        {tab === 'results' && (run ? <><div className="live-detail-title"><span className="live-overline">EVALUATION EVIDENCE</span><h2>{runLabels[run.status]}</h2><p>已记录 {run.trials.length} / {run.planned} 次执行 · {caseIds.length} 个案例</p></div><progress className="live-progress" max={run.planned || 1} value={run.trials.length} aria-label="已完成执行次数" /><div className="live-result-counts">{counts && (Object.keys(counts) as (keyof typeof counts)[]).map(verdict => <div className={verdict} key={verdict}><strong>{counts[verdict]}</strong><span>{verdictLabels[verdict]}</span></div>)}</div>
          {(run.judge || run.trials.some(trial => trial.judgeSource === 'llm')) && <section className="live-grading-overview" aria-label="本轮模型评分"><div><span className="live-overline">JUDGE</span><strong>{run.judge?.model || '本轮模型信息未记录'}</strong>{run.judge && <small>{run.judge.provider} · {run.judge.authMode === 'subscription' ? 'ChatGPT 订阅' : run.judge.authMode === 'api-key' ? 'API Key' : run.judge.authMode}</small>}</div><p>原始评分已完成 {gradingCompleted} 次{gradingFailed > 0 ? ` · 失败 ${gradingFailed} 次` : ''}{gradingCancelled > 0 ? ` · 停止 ${gradingCancelled} 次` : ''}{retriedTrialIds.size > 0 ? ` · 重试补齐 ${retriedTrialIds.size} 次` : ''}</p><small>规则结果与模型评分分别保留；业务规则失败会保留为未通过。</small>{retryableCount > 0 && run.status !== 'running' && <button className="live-secondary" disabled={disabled} onClick={() => void action('正在重试评分', '/run/retry-grading', { runId: run.id })}><RefreshCw size={13} />重试未完成评分 · {retryableCount}</button>}</section>}
          {caseIds.length > 0 && <><div className="live-review-toolbar"><label><input type="checkbox" checked={selected.size === caseIds.length} onChange={event => setSelected(event.target.checked ? new Set(caseIds) : new Set())} />全选 <span>已选 {selected.size} 项</span></label><div>{(Object.keys(decisionLabels) as HumanDecision[]).map(decision => <button disabled={disabled || selected.size === 0 || run.status === 'running'} key={decision} onClick={() => void review(decision)}>{decisionLabels[decision]}</button>)}</div></div>{reviewNotice && <p className="live-review-notice" role="status">{reviewNotice}</p>}<div className="live-cases">{caseIds.map(caseId => { const trials = run.trials.filter(trial => trial.caseId === caseId); const item = plan?.cases.find(candidate => candidate.id === caseId); return <section className={`live-case ${selected.has(caseId) ? 'selected' : ''}`} key={caseId}><div className="live-case-heading"><input type="checkbox" aria-label={`选择案例 ${caseId}`} checked={selected.has(caseId)} onChange={() => selectCase(caseId)} /><div><span className="live-overline">{caseId}</span><h3>{item?.name || caseId}</h3></div>{run.reviews[caseId] && <span className="live-human-verdict">{run.reviews[caseId] === 'recheck' && trials.some(trial => latestRechecks.has(trial.id)) ? '已交由 Agent 核查' : decisionLabels[run.reviews[caseId]]}</span>}</div>{item && <p className="live-expected">预期：{item.expected}</p>}{trials.map(trial => <TrialEvidence key={trial.id} trial={trial} recheck={latestRechecks.get(trial.id)} gradingRetry={gradingRetries.get(trial.id)} modelRun={Boolean(run.judge)} />)}</section>; })}</div></>}
          {run.status !== 'running' && <div className="live-results-footer"><p>人工复核单独记录，原始执行结果与判定证据保留。</p><button className="live-primary" disabled={disabled || !run.trials.length} onClick={() => void createReport()}><FileText size={15} />生成评测报告</button></div>}
        </> : <div className="live-empty"><MessageSquare size={29} /><h2>每一个判断都有证据</h2><p>评测运行后，这里会显示每次独立执行的输出、判定依据与 Trace，并支持批量人工复核。</p></div>)}
        {tab === 'report' && (currentReport ? <div className="live-report-preview"><div className="live-report-preview-heading"><span title={currentReport.filename}>本轮评测报告</span>{currentReport.pdfUrl && <a href={currentReport.pdfUrl} target="_blank" rel="noreferrer">PDF ↗</a>}<a href={currentReport.url} target="_blank" rel="noreferrer" aria-label="在新窗口打开报告"><ChevronRight size={16} /></a></div><iframe src={currentReport.url} title="本次真实评测报告" sandbox="allow-same-origin allow-downloads" /></div> : <div className="live-empty"><FileText size={29} /><h2>保留可以复查的结论</h2><p>报告根据本次实际执行结果生成，包含评测标准、案例结果和复核记录。</p><button className="live-primary" disabled={disabled || !run?.trials.length || run.status === 'running'} onClick={() => void createReport()}>生成报告<ChevronRight size={14} /></button></div>)}
      </div>
    </aside>}
  </div>;
}
