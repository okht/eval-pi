import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, ArrowUpRight, Check, ChevronDown, ChevronRight, CircleCheck, Clock3, FileCode2, FileText, Folder, FolderOpen, ListChecks, LoaderCircle, MoreHorizontal, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Pause, Play, Plus, RotateCcw, Search, Settings2, SquarePen, X } from 'lucide-react';
import ReviewPanel from './components/ReviewPanel';
import type { ReviewSubmission } from './components/ReviewPanel';
import ReportView, { buildReportHtml } from './components/ReportView';
import { buildCaseCsv, buildTraceJsonl, downloadTextFile } from './lib/demoData';
import { getEmbeddedReportFontCss } from './lib/reportFonts';

type Phase = 'review' | 'optimizing' | 'validating' | 'complete';
type Panel = 'progress' | 'files' | 'report';
type Message = { id: string; role: 'user' | 'assistant'; text: string; artifact?: 'report' | 'plan'; format?: 'pdf' | 'html' | 'md'; reportCompleted?: boolean; reportReview?: ReviewSubmission | null; reportId?: string };
type Snapshot = { phase: Phase; progress: number; paused: boolean; messages: Message[]; reportCreated: boolean; reportCompleted: boolean; reportReview: ReviewSubmission | null; reportId: string; reviewed: boolean; review: ReviewSubmission | null };
const INITIAL: Snapshot = { phase: 'review', progress: 0, paused: false, messages: [], reportCreated: false, reportCompleted: false, reportReview: null, reportId: 'r003-baseline-initial', reviewed: false, review: null };
const STORAGE_KEY = 'evalpi-preview-v1';

function readSnapshot(): Snapshot {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (value && ['review', 'optimizing', 'validating', 'complete'].includes(value.phase) && Array.isArray(value.messages)) return { ...INITIAL, ...value, paused: value.phase !== 'complete' && value.phase !== 'review' ? true : value.paused };
  } catch { /* A broken local preview state can safely start from the example. */ }
  return INITIAL;
}

function Mark({ small = false }: { small?: boolean }) {
  return <img className={small ? 'brand-mark small' : 'brand-mark'} src="/evalpi.svg" alt="" />;
}

export default function App() {
  const [run, setRun] = useState<Snapshot>(readSnapshot);
  const [panel, setPanel] = useState<Panel>('progress');
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth >= 1180);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [newTask, setNewTask] = useState(false);
  const [draft, setDraft] = useState('');
  const [attachment, setAttachment] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState('评测方案.md');
  const [toast, setToast] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [reportSnapshot, setReportSnapshot] = useState(run.reportCompleted);
  const [reportReview, setReportReview] = useState(run.reportReview);
  const [reportId, setReportId] = useState(run.reportId);
  const [generatingPdf, setGeneratingPdf] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const messageRef = useRef<HTMLDivElement>(null);
  const completed = run.phase === 'complete';
  const active = run.phase === 'optimizing' || run.phase === 'validating';

  useEffect(() => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(run)); } catch { /* Persistence is optional in private browser windows. */ } }, [run]);
  useEffect(() => { if (toast) { const timeout = setTimeout(() => setToast(''), 3600); return () => clearTimeout(timeout); } }, [toast]);
  useEffect(() => {
    if (!active || run.paused) return;
    const timer = setInterval(() => {
      setRun(previous => {
        if (previous.progress < 100) return { ...previous, progress: Math.min(100, previous.progress + 10) };
        if (previous.phase === 'optimizing') return { ...previous, phase: 'validating', progress: 0 };
        return { ...previous, phase: 'complete', progress: 100, messages: [...previous.messages, {
          id: crypto.randomUUID(), role: 'assistant', text: '本轮演示已完成。候选版本的任务完成率从 76.7% 提升到 91.7%，成本与响应时间保持在约定范围内。回归与独立盲测已完成，仍有 2 项问题需要继续关注。你可以让我生成本轮评测报告，查看完整对比和证据。',
        }] };
      });
    }, 500);
    return () => clearInterval(timer);
  }, [active, run.paused]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [run.messages.length]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') { event.preventDefault(); setSearchOpen(true); }
      if (event.key === 'Escape') { setMenuOpen(false); setCommandsOpen(false); setSearchOpen(false); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  function openPanel(tab: Panel) { setPanel(tab); setPanelOpen(true); }
  function openReport(snapshot: boolean, review = run.reportReview, id = run.reportId) { setReportSnapshot(snapshot); setReportReview(review); setReportId(id); openPanel('report'); }
  function saveAppendix(kind: 'cases' | 'traces', snapshot: boolean, id: string, review: ReviewSubmission | null = null) { downloadTextFile(`EvalPi_${id}_${kind === 'cases' ? 'case_results.csv' : 'traces.jsonl'}`, kind === 'cases' ? buildCaseCsv(snapshot, review) : buildTraceJsonl(snapshot, review), kind === 'cases' ? 'text/csv;charset=utf-8' : 'application/x-ndjson;charset=utf-8'); }
  function openFile(name: string) { setSelectedFile(name); openPanel('files'); }
  function append(message: Omit<Message, 'id'>) { setRun(previous => ({ ...previous, messages: [...previous.messages, { ...message, id: crypto.randomUUID() }] })); }

  function send(text = draft) {
    const prompt = text.trim();
    if (!prompt && !attachment) return;
    setNewTask(false); setDraft(''); setCommandsOpen(false);
    append({ role: 'user', text: prompt || `请查看附件 ${attachment}` });
    if (attachment) { append({ role: 'assistant', text: `已选择「${attachment}」。当前为前端交互预览，文件内容保留在本机。下面可以体验示例项目的评测与复核流程。` }); setAttachment(''); }
    if (/报告|导出|pdf|markdown|html/i.test(prompt)) {
      const format = /markdown|\.md/i.test(prompt) ? 'md' : /html/i.test(prompt) ? 'html' : 'pdf';
      const snapshotId = `r003-${completed ? 'validated' : 'baseline'}-${crypto.randomUUID().slice(0, 8)}`;
      const frozenReview = run.review ? structuredClone(run.review) : null;
      setRun(previous => ({ ...previous, reportCreated: true, reportCompleted: completed, reportReview: frozenReview, reportId: snapshotId }));
      append({ role: 'assistant', text: completed ? '本轮评测报告已生成，包含效果对比、关键改动和剩余问题。点击文件名查看报告；文件链接可以直接保存。' : '已根据当前进度生成阶段报告，基线结果与待核查事项已收录。候选版本尚未完成验证，报告会明确保留这些空缺。', artifact: 'report', format, reportCompleted: completed, reportReview: frozenReview, reportId: snapshotId });
      openReport(completed, frozenReview, snapshotId);
    } else if (/标准|方案|目标/.test(prompt)) {
      openFile('评测方案.md');
      append({ role: 'assistant', text: '本轮评测方案已放在侧栏。目标、数据集、约束与授权范围都在这份文件里。', artifact: 'plan' });
    } else if (/复核|确认|badcase|case/i.test(prompt)) {
      if (run.reviewed) append({ role: 'assistant', text: '这批代表案例已经完成提交。你可以在执行记录中查看人工判定与交由 Agent 核查的项目。' });
      else setReviewOpen(true);
    } else if (/进度/.test(prompt)) {
      openPanel('progress');
      append({ role: 'assistant', text: completed ? '本轮演示已完成，侧栏可以查看各阶段与资源使用情况。' : '已展开本轮进度。每个阶段、当前工作与本轮约定都可以在侧栏查看。' });
    } else if (/暂停/.test(prompt)) {
      setRun(previous => ({ ...previous, paused: true }));
      append({ role: 'assistant', text: active ? '本轮运行已暂停，当前进度已保存。' : '当前没有正在执行的任务。评测记录已保留。' });
    } else if (/继续/.test(prompt) && active) {
      setRun(previous => ({ ...previous, paused: false }));
      append({ role: 'assistant', text: '继续本轮运行。' });
    } else {
      append({ role: 'assistant', text: '已记录你的补充。这是一个使用示例数据的交互预览；你可以体验查看评测方案、批量复核、跟踪进度，以及通过对话生成报告。' });
    }
  }

  function submitReview(result: ReviewSubmission) {
    const values = Object.values(result.decisions);
    const confirmed = values.filter(value => value === 'issue').length;
    const cleared = values.filter(value => value === 'clear').length;
    const recheck = values.filter(value => value === 'recheck').length + result.uncheckedIds.length;
    setReviewOpen(false);
    setRun(previous => ({ ...previous, reviewed: true, review: result, phase: 'optimizing', progress: 0, paused: false, messages: [...previous.messages, {
      id: crypto.randomUUID(), role: 'assistant', text: `本批 ${result.total} 个案例已提交：人工确认有问题 ${confirmed} 项，判定无问题 ${cleared} 项，另外 ${recheck} 项交给 Agent 核查。明确的人工判断会保留；证据不足的项目保持待定。现在继续演示本轮调优与验证。`,
    }] }));
    openPanel('progress');
  }

  function reportUrl(format: 'html' | 'md' = 'html', snapshot = reportSnapshot, review: ReviewSubmission | null = null, id = reportId) {
    let text: string;
    if (format === 'html') {
      text = buildReportHtml(snapshot, review, id);
    } else {
      const reviewIds = review ? [...new Set([...Object.keys(review.decisions), ...review.uncheckedIds])].sort() : [];
      const pendingIds = reviewIds.filter(caseId => review?.decisions[caseId] === 'recheck' || (!review?.decisions[caseId] && review?.uncheckedIds.includes(caseId)));
      const describeReview = (caseId: string) => {
        const decision = review?.decisions[caseId];
        if (decision === 'issue') return '人工确认原始案例有问题；候选版本复测单独记录';
        if (decision === 'clear') return '人工判定无问题；保留人工结论，不进入修复';
        if (decision === 'recheck') return '人工选择不确定，交由 Agent 核查；当前快照保持待定';
        if (review?.uncheckedIds.includes(caseId)) return '未选择，交由 Agent 核查；当前快照保持待定';
        return '未人工复核，自动线索供后续核查';
      };
      const reviewLines = review
        ? reviewIds.map(caseId => `- ${caseId}：${describeReview(caseId)}`).join('\n')
        : '报告生成时尚无人工复核结论。后续判断不会追溯改写这份快照。';
      const evidenceLines = [
        ['CS-014', '工具超时后仍宣称提交成功'],
        ['CS-027', '售后重复提交缺少幂等检查'],
        ['CS-032', '超期政策边界判断不稳定'],
      ].map(([caseId, finding]) => `- ${caseId} · ${finding}。复核状态：${describeReview(caseId)}。`).join('\n');
      text = [
        '# 售后客服 Agent · 评测报告',
        '> 交互预览 · 以下均为示例数据',
        `快照：${id}\n\n状态：${snapshot ? '本轮自动验证演示完成，人工复核情况见下方' : '阶段报告，候选版本待验证'}`,
        '## 结论',
        `基线原始自动任务完成率：76.7%（276/360）。${snapshot ? '候选版本原始自动任务完成率：91.7%（330/360），提升 15 个百分点。' : '当前不提供候选版本达标结论。'}`,
        review ? '上述数值保留原始自动评分，尚未依据本次人工复核校准或重算，不代表人工验收结论。明确的人工判断独立保留；待核查与判定无问题的案例均不记为已修复。' : '上述数值使用原始自动评分口径，尚无人工验收结论。',
        '## 评测口径',
        `120 个独立 Case，每个重复 3 次，每个版本共 360 次执行；多轮对话在同一 Case 内保留上下文，不同 Case 之间复原初始状态。${snapshot ? '另有 60 个盲测 Case，每个重复 3 次；原始版本 135/180（75.0%），候选版本 162/180（90.0%），与基线集分开统计。' : ''}`,
        '## 人工复核快照',
        reviewLines,
        review ? '本节锁定报告生成时的人工判断。不确定与未选择项交由 Agent 核查，证据不足时保持待定，不进入自动修复。人工确认原始案例有问题，也不等同于候选版本已修复。' : '当前快照未包含后续人工复核数据。',
        '## 自动评测线索与复核状态',
        '以下保留原始自动线索供追溯；处理时遵循上方人工结论，自动证据不会覆盖明确的人工判断。',
        evidenceLines,
        '## 约束',
        '目标任务完成率 ≥90%，单次任务成本 ≤¥0.15，平均响应时间 ≤5s。',
        '## 后续核查',
        pendingIds.length ? `${pendingIds.join('、')} 在本快照中仍待核查。补齐证据后再作判定，不据当前自动评分宣称这些案例已修复。`
          : review ? '保留已明确的人工结论，仅对已确认的问题继续处理；依据复核结果校准评分器后，另行生成重算结果及候选版本验收结论。'
            : '重复申请的并发场景与质量售后的例外条款仍需补充验证。',
        '## 附录',
        `[逐次执行明细](EvalPi_${id}_case_results.csv)`,
        `[完整 Trace](EvalPi_${id}_traces.jsonl)`,
        '请将附录与报告保存在同一目录。\n',
      ].join('\n\n');
    }
    return URL.createObjectURL(new Blob([text], { type: format === 'html' ? 'text/html;charset=utf-8' : 'text/markdown;charset=utf-8' }));
  }

  async function downloadReport(format: 'pdf' | 'html' | 'md', event: React.MouseEvent<HTMLAnchorElement>, snapshot: boolean, review: ReviewSubmission | null, id: string) {
    if (format === 'html') {
      event.preventDefault();
      try {
        const fonts = await getEmbeddedReportFontCss();
        downloadTextFile(`EvalPi_${id}_评测报告.html`, buildReportHtml(snapshot, review, id, fonts), 'text/html;charset=utf-8');
        setToast('HTML 报告已保存，字体可离线使用');
      } catch { setToast('报告字体加载未完成，请重试。'); }
      return;
    }
    if (format === 'pdf') {
      event.preventDefault();
      if (generatingPdf) return;
      setGeneratingPdf(id);
      try {
        const { createReportPdf } = await import('./components/ReportPdf');
        const blob = await createReportPdf(snapshot, review, id);
        const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
        anchor.href = url; anchor.download = `EvalPi_${id}_评测报告.pdf`; anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000); setToast('PDF 已生成并开始下载');
      } catch (error) { console.error(error); setToast('PDF 生成失败，请重试或在对话中请求 HTML 报告。'); }
      finally { setGeneratingPdf(null); }
      return;
    }
    const url = reportUrl(format, snapshot, review, id);
    event.currentTarget.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const stages = [
    { title: '理解项目', description: '运行入口、业务目标与项目约束', done: true },
    { title: '确认评测方案', description: '标准 v1.2 · 120 个 Case', done: true },
    { title: '运行基线评测', description: '360 / 360 次执行已完成', done: true },
    { title: '复核关键案例', description: run.reviewed ? '人工判断已保存，待定项单独保留' : '5 个候选问题 · 1 个通过样本抽查', done: run.reviewed, current: run.phase === 'review' },
    { title: '自动调优', description: run.phase === 'optimizing' ? '在项目副本中调整工具结果校验' : '优化后核验状态，再生成回复', done: run.phase === 'validating' || completed, current: run.phase === 'optimizing' },
    { title: '回归与独立盲测', description: completed ? '验证完成，2 项问题需继续关注' : '固定标准与版本，独立验证效果', done: completed, current: run.phase === 'validating' },
  ];

  return <div className={`app-shell ${sidebarOpen ? '' : 'nav-collapsed'} ${panelOpen && !newTask ? 'detail-open' : ''}`}>
    <aside className="workspace-sidebar">
      <div className="brand-row"><a className="brand" href="#" onClick={event => { event.preventDefault(); setNewTask(false); }} aria-label="EvalPi 工作区"><Mark /><span>EvalPi<span className="brand-period">.</span></span></a><button className="icon-button" aria-label="收起导航" onClick={() => setSidebarOpen(false)}><PanelLeftClose size={17} /></button></div>
      <button className="new-task-button" onClick={() => { setNewTask(true); setPanelOpen(false); setDraft(''); inputRef.current?.focus(); }}><SquarePen size={16} /><span>新建评测</span><span className="shortcut">＋</span></button>
      <button className="nav-search" onClick={() => setSearchOpen(true)}><Search size={15} /><span>搜索任务与文件</span><kbd>⌘ K</kbd></button>
      <div className="nav-section-label"><span>工作区</span><span className="mono">01</span></div>
      <button className={`project-button ${!newTask ? 'selected' : ''}`} onClick={() => { setNewTask(false); openPanel('progress'); }}><FolderOpen size={16} /><span>售后客服 Agent</span><ChevronDown size={13} /></button>
      <div className="project-task-list">
        <button className={!newTask ? 'task-link active' : 'task-link'} onClick={() => { setNewTask(false); openPanel('progress'); }}><span className={`state-dot ${completed ? 'green' : 'amber'}`} /><span>提升售后任务完成率</span></button>
        <button className="task-link secondary" onClick={() => { setNewTask(false); openFile('项目理解.md'); }}><FileText size={13} /><span>项目理解与评测标准</span></button>
      </div>
      <div className="sidebar-note"><span className="mono">A LITTLE BETTER,<br />EVERY ITERATION.</span><div className="small-rule" /></div>
      <div className="workspace-footer"><div className="preview-tag"><span className="state-dot" />交互预览 · 示例数据</div><div className="profile-row"><span className="avatar">Y</span><div><strong>我的工作区</strong><span>本地项目</span></div><div className="menu-anchor"><button className="icon-button" aria-label="工作区选项" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}><MoreHorizontal size={18} /></button>{menuOpen && <div className="workspace-menu"><button onClick={() => { setRun(INITIAL); setNewTask(false); setMenuOpen(false); openPanel('progress'); setToast('已重置为初始演示状态'); }}><RotateCcw size={14} />重新开始演示</button><button onClick={() => { setMenuOpen(false); openFile('关于此预览.md'); }}><Settings2 size={14} />关于此预览</button></div>}</div></div></div>
    </aside>

    <main className="main-workspace">
      <header className="workspace-header"><div className="breadcrumb">{!sidebarOpen && <button className="icon-button" aria-label="展开导航" onClick={() => setSidebarOpen(true)}><PanelLeftOpen size={18} /></button>}<span>工作区</span><ChevronRight size={13} /><strong>{newTask ? '新建评测' : '售后客服 Agent'}</strong></div><div className="header-actions"><span className="local-indicator"><span />本地</span><button className={`icon-button ${panelOpen ? 'is-active' : ''}`} aria-label={panelOpen ? '收起详情侧栏' : '展开详情侧栏'} onClick={() => { setNewTask(false); setPanelOpen(!panelOpen); }}>{panelOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}</button></div></header>

      <div className="conversation-scroll" ref={messageRef}>
        {newTask ? <section className="welcome-state"><div className="welcome-graphic"><Mark /><span className="orbit-square one" /><span className="orbit-square two" /><span className="orbit-square three" /></div><span className="eyebrow">FROM WORKING TO WORKING WELL</span><h1>让你的 Agent，<br /><em>更进一步。</em></h1><p>交给我项目，告诉我目标。<br />我们从一次有依据的评测开始。</p><div className="starter-actions"><button onClick={() => fileRef.current?.click()}><FolderOpen size={17} /><span>带入项目文件</span><ArrowUpRight size={14} /></button><button onClick={() => { setNewTask(false); openPanel('progress'); }}><Play size={15} /><span>体验客服 Agent 示例</span><ArrowUpRight size={14} /></button></div></section> : <div className="conversation-content">
          <div className="conversation-heading"><div><span className="eyebrow">EVALUATION / 003</span><h1>售后客服 Agent</h1><p>提升任务完成率，验证每一次改进。</p></div><span className="round-label">第 3 轮</span></div>
          <div className="message user-message"><div className="user-bubble">这是我刚搭好的售后客服 Agent。帮我找出问题，把任务完成率提升到 90% 以上。每次调用成本别超过 0.15 元，响应控制在 5 秒内。<button className="attached-project" onClick={() => openFile('项目理解.md')}><Folder size={16} /><span>after-sales-agent</span><span className="mono">LOCAL</span></button></div></div>
          <div className="message assistant-message"><div className="assistant-identity"><Mark small /><span>EvalPi</span><span className="muted">·</span><span className="muted">项目已读取</span></div><div className="message-body"><p>我已理解这个项目。接下来会重点检查<strong>售后动作是否真正完成</strong>、政策判断是否准确，以及异常时能否正确处理。</p><p>评测会在独立副本中进行，保留现有业务规则和对外接口。</p><div className="inline-artifacts"><button onClick={() => openFile('评测方案.md')}><FileText size={15} /><span>评测方案.md</span><ArrowUpRight size={12} /></button><button onClick={() => openFile('评测标准.md')}><ListChecks size={15} /><span>评测标准 · v1.2</span><ArrowUpRight size={12} /></button></div><div className="confirmed-line"><Check size={13} /><span>方案已确认</span><span className="divider-dot">·</span><span>120 个 Case，每个重复 3 次</span></div></div></div>
          <div className="run-divider"><span /><button onClick={() => openPanel('progress')}><CircleCheck size={13} />基线评测已完成 <span className="mono">04:32</span><ChevronRight size={12} /></button><span /></div>
          <div className="message assistant-message"><div className="assistant-identity"><Mark small /><span>EvalPi</span></div><div className="message-body"><p>基线任务完成率为 <strong className="number-highlight">76.7%</strong>。主要问题集中在<strong>工具执行失败后，仍向用户宣称成功</strong>，以及少量重复提交和政策边界判断。</p><div className="baseline-stats"><div><span>任务完成率</span><strong>76.7<span>%</span></strong><small>276 / 360 次执行</small></div><div><span>平均任务成本</span><strong><span>¥</span>0.12</strong><small>约定上限 ¥0.15</small></div><div><span>平均响应时间</span><strong>3.8<span>s</span></strong><small>约定上限 5s</small></div></div><p>我整理了 <strong>6 个代表案例</strong>供你批量确认，其中包含 1 个通过样本抽查。其余细节都保存在侧栏。</p>
            <div className={`review-invite ${run.reviewed ? 'submitted' : ''}`}><div className="review-invite-icon">{run.reviewed ? <Check size={18} /> : <ListChecks size={19} />}</div><div><strong>{run.reviewed ? '本批判断已提交' : '确认这批案例，然后继续调优'}</strong><span>{run.reviewed ? '人工判定已保留，其余项目由 Agent 核查' : '支持多选与批量判断，未选择项交由 Agent 核查'}</span></div><button className={run.reviewed ? 'text-button' : 'dark-button'} onClick={() => run.reviewed ? openFile('复核记录.md') : setReviewOpen(true)}>{run.reviewed ? '查看记录' : '批量复核'}<ArrowRight size={14} /></button></div>
          </div></div>
          {run.messages.map(message => <div className={`message ${message.role === 'user' ? 'user-message' : 'assistant-message'}`} key={message.id}>{message.role === 'user' ? <div className="user-bubble">{message.text}</div> : <><div className="assistant-identity"><Mark small /><span>EvalPi</span></div><div className="message-body"><p>{message.text}</p>{message.artifact === 'report' && <div className="report-artifact"><button className="report-file" onClick={() => openReport(message.reportCompleted ?? false, message.reportReview ?? null, message.reportId ?? message.id.slice(0, 8))}><span className="report-file-icon"><FileText size={20} /></span><span><strong>售后客服 Agent · {message.reportCompleted ? '评测报告' : '阶段报告'}</strong><small>{message.format?.toUpperCase() || 'HTML'} · 第 3 轮 · 点击预览</small></span><ArrowUpRight size={16} /></button><div className="artifact-links"><a href="#" download={`EvalPi_${message.reportId ?? message.id.slice(0, 8)}_评测报告.${message.format || 'pdf'}`} onClick={event => downloadReport(message.format || 'pdf', event, message.reportCompleted ?? false, message.reportReview ?? null, message.reportId ?? message.id.slice(0, 8))}>{generatingPdf === message.reportId ? '正在排版 PDF…' : `售后客服Agent_评测报告.${message.format || 'pdf'}`}<ArrowDown size={12} /></a><span>文件可直接保存</span></div><div className="appendix-links"><button onClick={() => saveAppendix('cases', message.reportCompleted ?? false, message.reportId ?? message.id.slice(0, 8), message.reportReview ?? null)}>逐条结果.csv<ArrowDown size={11} /></button><button onClick={() => saveAppendix('traces', message.reportCompleted ?? false, message.reportId ?? message.id.slice(0, 8), message.reportReview ?? null)}>运行Trace.jsonl<ArrowDown size={11} /></button></div></div>}{message.artifact === 'plan' && <button className="inline-file" onClick={() => openFile('评测方案.md')}><FileText size={15} />评测方案.md<ArrowUpRight size={13} /></button>}</div></>}</div>)}
          {active && <div className="working-line" role="status"><LoaderCircle size={15} className={run.paused ? '' : 'spin'} /><span>{run.paused ? '任务已暂停，进度已保存' : run.phase === 'optimizing' ? '正在优化工具结果校验与回复流程…' : '正在进行回归与独立盲测…'}</span><span className="mono">{run.progress}%</span></div>}
          <div ref={endRef} />
        </div>}
      </div>

      <div className="composer-region">{!newTask && <div className="suggestion-row"><button onClick={() => send('查看本轮评测进度')}>查看进度<ArrowUpRight size={11} /></button><button onClick={() => send('生成本轮评测报告')}>生成评测报告<ArrowUpRight size={11} /></button>{active && <button onClick={() => setRun(previous => ({ ...previous, paused: !previous.paused }))}>{run.paused ? <Play size={11} /> : <Pause size={11} />}{run.paused ? '继续运行' : '暂停运行'}</button>}</div>}
        <div className="composer" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) setAttachment(file.name); }}>
          {attachment && <div className="composer-attachment"><FileText size={13} />{attachment}<button className="icon-button" aria-label="移除附件" onClick={() => setAttachment('')}><X size={12} /></button></div>}
          <textarea ref={inputRef} value={draft} onChange={event => { setDraft(event.target.value); setCommandsOpen(event.target.value === '/'); }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} placeholder={newTask ? '告诉我你想评测什么，或者带入一个项目…' : '继续说明目标，或让我生成评测报告…'} aria-label="给 EvalPi 发送消息" rows={2} />
          <div className="composer-toolbar"><div className="composer-tools"><button className="icon-button" aria-label="添加本地文件" onClick={() => fileRef.current?.click()}><Plus size={18} /></button><button className="model-button" onClick={() => { setDraft('查看本轮评测方案和模型配置'); inputRef.current?.focus(); }}><span className="model-spark">✳</span>主模型 · 自动<ChevronDown size={11} /></button></div><div className="composer-right"><span className="composer-hint">Enter 发送</span><button className="send-button" aria-label="发送消息" disabled={!draft.trim() && !attachment} onClick={() => send()}><ArrowUp size={17} /></button></div></div>
          {commandsOpen && <div className="command-menu">{['生成本轮评测报告', '查看本轮评测进度', '查看评测标准', '批量复核案例'].map(command => <button key={command} onClick={() => send(command)}><ArrowUpRight size={14} />{command}</button>)}</div>}
        </div><div className="composer-footnote"><span>评测有依据，改进有记录。</span><span className="mono">EVALPI / PREVIEW</span></div>
      </div>
    </main>

    {panelOpen && !newTask && <aside className={`detail-panel ${panel === 'report' ? 'report-mode' : ''}`}><div className="detail-header"><span>{panel === 'report' ? '报告预览' : '任务详情'}</span><button className="icon-button" aria-label="关闭详情侧栏" onClick={() => setPanelOpen(false)}><X size={16} /></button></div><div className="detail-tabs" role="tablist" aria-label="任务详情">{(['progress', 'files', 'report'] as Panel[]).map(tab => <button key={tab} role="tab" aria-selected={panel === tab} className={panel === tab ? 'active' : ''} onClick={() => setPanel(tab)}>{tab === 'progress' ? '进度' : tab === 'files' ? '资料' : '报告'}{tab === 'report' && run.reportCreated && <span className="tab-dot" />}</button>)}</div>
      <div className="detail-body" role="tabpanel">
        {panel === 'progress' && <><div className="detail-heading"><span className="eyebrow">THIS ITERATION</span><div><h2>{completed ? '本轮验证完成' : run.phase === 'review' ? '等待你的判断' : run.paused ? '任务已暂停' : run.phase === 'optimizing' ? '让问题逐个解决' : '独立验证改进'}</h2><span className={`status-label ${completed ? 'success' : ''}`}>{completed ? '已完成' : run.phase === 'review' ? '待复核' : run.paused ? '已暂停' : '进行中'}</span></div><p>{completed ? '结果与证据已保留，候选版本等待你验收。' : '已完成的工作和接下来的安排，都在这里。'}</p></div><div className="stage-list">{stages.map((stage, index) => <div className={`stage ${stage.done ? 'done' : ''} ${stage.current ? 'current' : ''}`} key={stage.title}><div className="stage-marker">{stage.done ? <Check size={12} /> : stage.current ? <span /> : <span className="stage-number">{index + 1}</span>}</div><div className="stage-copy"><strong>{stage.title}</strong><p>{stage.description}</p>{stage.current && active && <div className="thin-progress"><span style={{ width: `${run.progress}%` }} /></div>}{stage.current && run.phase === 'review' && <button className="stage-link" onClick={() => setReviewOpen(true)}>打开批量复核<ArrowUpRight size={12} /></button>}</div></div>)}</div>
          <section className="detail-section"><div className="section-title"><h3>本轮约定</h3><button className="text-button" onClick={() => openFile('评测方案.md')}>查看方案<ArrowUpRight size={11} /></button></div><dl className="constraint-list"><div><dt>任务完成率</dt><dd>≥ 90<span>%</span></dd></div><div><dt>单次任务成本</dt><dd>≤ ¥0.15</dd></div><div><dt>响应时间</dt><dd>≤ 5<span>s</span></dd></div><div><dt>修改范围</dt><dd className="plain-value">项目副本 · 内部实现</dd></div></dl></section>
          <section className="detail-section"><div className="section-title"><h3>资源使用</h3><span className="mono small-muted">本轮预算</span></div><div className="budget-line"><strong>¥{completed ? '140.40' : '43.20'}</strong><span>/ ¥200.00</span></div><div className="budget-track"><span style={{ width: completed ? '70.2%' : '21.6%' }} /></div><div className="budget-caption"><span><Clock3 size={12} />{completed ? '12 分 18 秒' : '4 分 32 秒'}</span><span>费用均为演示数据</span></div></section>
          <section className="detail-section"><div className="section-title"><h3>本轮文件</h3><span className="mono small-muted">03</span></div>{['评测方案.md', '评测标准.md', '基线执行记录.jsonl'].map(name => <button className="file-row" key={name} onClick={() => openFile(name)}>{name.endsWith('jsonl') ? <FileCode2 size={15} /> : <FileText size={15} />}<span>{name}</span><ArrowUpRight size={12} /></button>)}</section>
        </>}
        {panel === 'files' && <><div className="file-picker"><span className="eyebrow">PROJECT ARTIFACTS</span><select aria-label="选择项目文件" value={selectedFile} onChange={event => setSelectedFile(event.target.value)}>{['评测方案.md', '评测标准.md', '项目理解.md', '基线执行记录.jsonl', '复核记录.md', '关于此预览.md'].map(file => <option key={file}>{file}</option>)}</select></div><FilePreview name={selectedFile} reviewed={run.reviewed} review={run.review} /></>}
        {panel === 'report' && (run.reportCreated ? <ReportView completed={reportSnapshot} review={reportReview} snapshotId={reportId} onAppendix={kind => saveAppendix(kind, reportSnapshot, reportId, reportReview)} /> : <div className="empty-report"><div className="paper-stack"><FileText size={31} strokeWidth={1.2} /></div><span className="eyebrow">A RECORD OF PROGRESS</span><h2>把这次迭代，<br />留成一份有用的报告。</h2><p>结论、效果对比与关键证据，<br />会收在同一份报告里。</p><button className="text-button" onClick={() => { setDraft('生成本轮评测报告'); inputRef.current?.focus(); }}>在对话中生成<ArrowUpRight size={13} /></button><small>报告通过对话中的文件链接查看和保存。</small></div>)}
      </div><div className="panel-footer"><span className="state-dot green" />本地保存<span>·</span><span>示例项目</span></div></aside>}
    <input ref={fileRef} type="file" multiple accept=".md,.txt,.json,.jsonl,.py,.ts,.js,.zip" className="visually-hidden" onChange={event => { const files = event.target.files; if (files?.length) setAttachment(files.length > 1 ? `${files[0].name} 等 ${files.length} 个文件` : files[0].name); event.target.value = ''; }} />
    {reviewOpen && <ReviewPanel onClose={() => setReviewOpen(false)} onSubmit={submitReview} />}
    {searchOpen && <div className="search-overlay" onMouseDown={event => { if (event.target === event.currentTarget) setSearchOpen(false); }}><section className="search-dialog" role="dialog" aria-modal="true" aria-label="搜索任务与文件"><div className="search-input"><Search size={18} /><input autoFocus placeholder="搜索任务或文件…" aria-label="搜索关键词" value={search} onChange={event => setSearch(event.target.value)} /><button className="icon-button" aria-label="关闭搜索" onClick={() => setSearchOpen(false)}><X size={17} /></button></div><div className="search-results">{['售后客服 Agent', '评测方案.md', '评测标准.md', '项目理解.md', '基线执行记录.jsonl'].filter(item => item.toLowerCase().includes(search.toLowerCase())).map(item => <button key={item} onClick={() => { setSearchOpen(false); setNewTask(false); item.endsWith('Agent') ? openPanel('progress') : openFile(item); }}><FileText size={16} /><span>{item}</span><ArrowUpRight size={13} /></button>)}{!['售后客服 Agent', '评测方案.md', '评测标准.md', '项目理解.md', '基线执行记录.jsonl'].some(item => item.toLowerCase().includes(search.toLowerCase())) && <p className="no-results">没有找到相关任务或文件。</p>}</div><div className="search-hint">搜索当前示例项目中的任务与材料</div></section></div>}
    {toast && <div className="toast" role="status"><CircleCheck size={16} />{toast}</div>}
  </div>;
}

function FilePreview({ name, reviewed, review }: { name: string; reviewed: boolean; review: ReviewSubmission | null }) {
  if (name === '关于此预览.md') return <article className="document-preview"><h2>关于此预览</h2><p>这是 EvalPi 的可交互前端，用示例项目展示对话、侧栏、进度、批量确认和报告的使用方式。</p><h3>数据与执行</h3><p>页面中的模型结果、费用和运行进度均为演示数据。当前没有调用模型 API，也不会修改本地项目。</p><h3>可体验的操作</h3><p>批量复核、暂停与继续、查看文件、搜索、生成并保存报告。输入内容与当前进度仅保存在本机浏览器中。</p></article>;
  if (name === '基线执行记录.jsonl') return <article className="document-preview"><h2>基线执行记录</h2><p className="doc-meta">示例摘录 · 360 次执行</p><pre>{'{\n  "case": "CS-014",\n  "trial": 2,\n  "tool": "create_after_sale",\n  "tool_result": "timeout",\n  "agent_reply": "已为您提交申请",\n  "backend_record": null,\n  "verdict": "candidate_issue",\n  "duration_ms": 3840\n}'}</pre><p>工具结果和后台状态与回复不一致，进入候选问题复核。每次尝试使用该 Case 的预设初始状态。</p></article>;
  if (name === '复核记录.md') return <article className="document-preview"><h2>复核记录</h2><p className="doc-meta">第 3 轮 · 代表案例批次</p><p>{reviewed ? '本批判断已提交。人工确认与自动核查分开记录；待定项目不进入自动修复。' : '本批尚未提交。你可以从对话或进度侧栏打开批量复核。'}</p>{review && <div className="review-records">{Object.entries(review.decisions).map(([id, decision]) => <div key={id}><code>{id}</code><span>{decision === 'issue' ? '人工确认有问题' : decision === 'clear' ? '人工判定无问题' : '交由 Agent 核查'}</span></div>)}{review.uncheckedIds.map(id => <div key={id}><code>{id}</code><span>未选择，交由 Agent 核查</span></div>)}</div>}<h3>判定规则</h3><p>确认有问题：进入报告或调优。</p><p>判定无问题：保留人工结论。</p><p>不确定与未选择：交由 Agent 核查；仍证据不足则保持待定。</p></article>;
  if (name === '项目理解.md') return <article className="document-preview"><span className="doc-meta">PROJECT CONTEXT</span><h2>售后客服 Agent</h2><p>帮助客户查询订单、判断售后政策、创建申请，并在异常时说明情况或转人工。</p><h3>主要流程</h3><ol><li>识别用户售后意图</li><li>查询订单与适用政策</li><li>补充必要信息</li><li>提交申请并核验结果</li><li>向用户说明状态与下一步</li></ol><h3>本轮关注</h3><p>优先排查宣称成功但业务动作未完成的情况，再检查政策边界、幂等和超时兜底。</p><div className="doc-note">示例项目，用于展示交互。尚未连接真实售后系统。</div></article>;
  if (name === '评测标准.md') return <article className="document-preview"><span className="doc-meta">RUBRIC / V1.2</span><h2>评测标准</h2>{[['业务动作完成', '结合工具结果和测试后台，核验申请是否真实创建，并关联正确订单。'], ['回复与事实一致', '不得在失败、超时或结果未知时宣称提交成功。'], ['政策判断准确', '依据确认过的售后规则处理期限、凭证和例外条件。'], ['异常有明确出口', '解释当前状态，给出下一步；需要时正确转人工。']].map(([title, text], index) => <section className="rubric-item" key={title}><span className="mono">0{index + 1}</span><div><h3>{title}</h3><p>{text}</p></div></section>)}<div className="doc-note">缺少证据时标记待定，不根据回复语气推断业务成功。</div></article>;
  return <article className="document-preview"><span className="doc-meta">EVALUATION PLAN / V1.2</span><h2>把售后任务真正完成</h2><p className="doc-lead">以业务完成情况为主，在约定成本和响应时间内提高可靠性。</p><h3>验收目标</h3><ul><li>任务完成率 ≥ 90%</li><li>单次任务成本 ≤ ¥0.15</li><li>平均响应时间 ≤ 5 秒</li></ul><h3>测试安排</h3><p>基线集 120 个 Case，每个独立运行 3 次。覆盖常规售后、政策边界、工具异常与多轮补充信息。</p><h3>调优与验证</h3><p>在项目副本中调整内部实现，保持业务规则和对外接口约定。回归后使用独立盲测验证。</p><h3>预算与停止</h3><p>本轮预算 ¥200，最多 4 轮迭代。达标并完成验证、预算用尽，或持续无明显改善时停止。</p><div className="doc-note"><Check size={14} />方案已确认 · 所有数值均为示例</div></article>;
}
