/// <reference types="vite/client" />
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReviewSubmission } from './ReviewPanel';
import { evalPiLogoBlack, evalPiLogoShapes, evalPiLogoViewBox, evalPiWatermarkOpacity } from '../lib/brandLogo';
import reportThemeCss from '../design-system/reports/theme.css?raw';
import reportLayoutCss from '../design-system/reports/report.css?raw';
import reportCompositionCss from './report.css?raw';
import '../design-system/reports/theme.css';
import '../design-system/reports/report.css';
import './report.css';

type ReportProps = {
  completed: boolean;
  review?: ReviewSubmission | null;
  snapshotId?: string;
  onAppendix?: (kind: 'cases' | 'traces') => void;
};

function ReportLogo({ watermark = false }: { watermark?: boolean }) {
  return <svg
    className={watermark ? 'eval-report-cover-mark' : 'eval-report-logo'}
    xmlns="http://www.w3.org/2000/svg"
    viewBox={evalPiLogoViewBox}
    role={watermark ? undefined : 'img'}
    aria-label={watermark ? undefined : 'EvalPi'}
    aria-hidden={watermark ? true : undefined}
    style={watermark ? { opacity: evalPiWatermarkOpacity } : undefined}
  >{evalPiLogoShapes.map(shape => <path key={shape.fill} d={shape.d} fill={watermark ? shape.fill : evalPiLogoBlack} />)}</svg>;
}

function reviewState(id: string, review?: ReviewSubmission | null) {
  const decision = review?.decisions[id];
  if (decision === 'clear' || decision === 'issue') return decision;
  if (decision === 'recheck' || review?.uncheckedIds.includes(id)) return 'pending';
  return 'unreviewed';
}

function reportSnapshotId(completed: boolean, snapshotId?: string) {
  return snapshotId?.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 96) || (completed ? 'validated' : 'baseline');
}

const metrics = [
  { label: '任务完成率', baseline: '76.7', candidate: '91.7', unit: '%', note: '目标 ≥ 90%', delta: '+15.0 个百分点' },
  { label: '平均任务成本', baseline: '0.12', candidate: '0.14', unit: '元', note: '上限 ¥0.15', delta: '+¥0.02 / 次' },
  { label: '平均响应时间', baseline: '3.8', candidate: '4.2', unit: '秒', note: '上限 5 秒', delta: '+0.4 秒 / 次' },
  { label: '通过的执行', baseline: '276', candidate: '330', unit: '/ 360', note: '120 个 Case × 3 次', delta: '+54 次通过' },
];

function Comparison({ completed }: ReportProps) {
  return <figure className="eval-report-comparison" aria-label={completed ? '同一基线评测集：原始版本通过率 76.7%，候选版本通过率 91.7%，目标 90%' : '基线评测集：原始版本通过率 76.7%，目标 90%，候选版本尚未完成'}>
    <div className="eval-report-chart-key"><span><i className="eval-report-key-original" />原始版本</span>{completed && <span><i className="eval-report-key-candidate" />候选版本</span>}<span className="eval-report-target-label">目标 90%</span></div>
    <div className="eval-report-bar-row"><span>原始版本</span><div className="eval-report-bar-track"><div className="eval-report-bar baseline" style={{ width: '76.6667%' }} /><i className="eval-report-target" style={{ left: '90%' }} /></div><strong>76.7%</strong></div>
    {completed && <div className="eval-report-bar-row"><span>候选版本</span><div className="eval-report-bar-track"><div className="eval-report-bar candidate" style={{ width: '91.6667%' }} /><i className="eval-report-target" style={{ left: '90%' }} /></div><strong>91.7%</strong></div>}
    <div className="eval-report-chart-axis" aria-hidden="true"><span>0%</span><span>50%</span><span>100%</span></div>
    <figcaption>同一套 120 个 Case，各独立运行 3 次。按执行次数计算通过率，单次偶发失败保留记录。</figcaption>
  </figure>;
}

function Evidence({ completed, review }: ReportProps) {
  const cases = [
    {
      id: 'CS-014', title: '提交结果与对客回复核验',
      observation: '申请接口超时，测试后台没有新增记录；原始版本仍回复「已为您提交申请」。',
      standard: '工具结果、后台状态与对客回复一致。',
      progress: '增加提交结果核验。只有工具返回成功且后台确认创建后，才告知用户提交成功；状态未知时解释情况并提供下一步。',
      trace: 'create_after_sale → timeout\nbackend.application → null\nagent.reply → 已为您提交申请',
      evidence: '基线执行记录 / CS-014 / 第 2 次尝试',
      baselineStatus: '自动发现问题', candidateStatus: '自动复测改善',
    },
    {
      id: 'CS-027', title: '同一订单的重复申请核验',
      observation: '用户重复确认后，原始版本生成了两张有效售后单。',
      standard: '核对订单、诉求与已有申请状态，同一诉求应保持幂等。',
      progress: '已增加提交前查询与请求标识。并发重试仍需进一步验证，当前证据不足以证明所有重复请求都被正确处理。',
      evidence: '基线执行记录 / CS-027', baselineStatus: '自动发现问题', candidateStatus: '仍需关注',
    },
    {
      id: 'CS-032', title: '退货期限与质量售后的边界',
      observation: '购买 12 天的商品出现质量问题，Agent 仅依据七天无理由期限拒绝售后。',
      standard: '区分无理由退货与质量问题售后，检索当前适用的业务规则。',
      progress: '已拆分两类政策的判断路径。商家例外条款尚未补齐，相关结论保持待定，补齐规则后再验证。',
      evidence: '政策检索记录 / CS-032', baselineStatus: '需核对标准', candidateStatus: '待补充验证',
    },
  ];
  return <div className="eval-report-evidence-list">{cases.map((item, index) => {
    const state = reviewState(item.id, review);
    const canShowProgress = completed && state !== 'clear' && state !== 'pending';
    const label = state === 'clear' ? '人工判定无问题' : state === 'issue' ? '人工确认有问题' : state === 'pending' ? '待核查' : completed ? item.candidateStatus : item.baselineStatus;
    const tone = state === 'clear' ? 'confirmed' : state === 'pending' ? 'pending' : state === 'issue' ? 'issue' : completed && index === 0 ? 'confirmed' : index === 2 ? 'pending' : 'issue';
    return <details key={item.id} className="eval-report-evidence" id={`report-case-${item.id.slice(3)}`} open={index === 0}>
      <summary><span className="eval-report-evidence-id">{item.id}</span><span className="eval-report-evidence-heading">{item.title}</span><span className={`eval-report-status ${tone}`}>{label}</span></summary>
      <div className="eval-report-evidence-body">
        {state === 'clear' && <p className="eval-report-review-note confirmed">以人工判定无问题为本次复核结论。下方自动证据仅供追溯，不覆盖人工结论，也不据此宣称故障已修复。</p>}
        {state === 'issue' && <p className="eval-report-review-note issue">人工已确认原始案例有问题。候选版本的自动复测单独记录，不替代这次人工判断。</p>}
        {state === 'pending' && <p className="eval-report-review-note pending">该案例已交由 Agent 核查。当前快照尚无核查结论，保持待定，不进入自动修复。</p>}
        <p><strong className="eval-report-observation-label">原始自动记录：</strong>{item.observation}</p>
        <dl><div><dt>原始判定依据</dt><dd>{item.standard}</dd></div>{canShowProgress && <div><dt>候选自动复测记录</dt><dd>{item.progress}</dd></div>}</dl>
        {item.trace && <pre aria-label={`${item.id} 示例执行证据`}>{item.trace}</pre>}
        <p className="eval-report-evidence-footnote">证据：{item.evidence}{canShowProgress ? `；候选复测记录 / ${item.id}` : ''}。</p>
      </div>
    </details>;
  })}</div>;
}

export default function ReportView({ completed, review, snapshotId, onAppendix }: ReportProps) {
  const snapshot = reportSnapshotId(completed, snapshotId);
  const pendingIds = review ? [...new Set([...review.uncheckedIds, ...Object.keys(review.decisions)])].filter(id => reviewState(id, review) === 'pending') : [];
  const hasPendingReview = pendingIds.length > 0;
  const hasHumanClear = review ? Object.values(review.decisions).includes('clear') : false;
  const hasHumanReview = review != null;
  const remainingIds = ['CS-027', 'CS-032'].filter(id => reviewState(id, review) !== 'clear');
  const verdictTitle = !completed ? '完成率未达标，优先核验提交结果。' : hasPendingReview ? '自动指标达标，待定案例仍需核查。' : hasHumanReview ? '自动指标达标，人工校准待重算。' : '自动指标达标，两个场景仍需验证。';
  const actions = hasHumanReview ? [
    ['复核闭环', hasPendingReview ? `${pendingIds.join('、')} 仍待核查，补齐证据后再作判定；明确判定无问题的案例保留人工结论。` : '保留人工判断与依据，仅对已确认的问题继续处理；判定无问题的案例不进入修复。'],
    ['评分校准', '依据人工复核检查自动评分器，固定新版本后重算可比结果，保留原始评分供追溯。'],
    ['候选验收', completed ? '结合校准后的评分与剩余场景验证，再由产品经理和研发决定是否采用。' : '处理已确认的问题，完成同集回归与独立盲测后，再给出候选版本的验收结论。'],
  ] : completed ? [
    ['研发', '增加并发重试测试，核验同一订单与诉求的幂等条件。'],
    ['产品经理', '补齐商家质量售后的例外条款，确认有争议案例的预期。'],
    ['共同确认', '查看补充验证结果，再决定是否采用候选版本。'],
  ] : [
    ['优先修复', '加入工具返回与后台记录的双重核验，补齐超时后的状态查询。'],
    ['继续调优', '处理重复申请和政策判断路径，保留原始版本用于比较。'],
    ['独立验证', '完成同集回归与盲测后，再给出候选版本的验收结论。'],
  ];
  return <article className="eval-report" aria-label={completed ? '售后客服 Agent 调优评测报告，示例数据' : '售后客服 Agent 基线评测报告，示例数据'}>
    <header className="eval-report-header">
      <div className="eval-report-brandline"><div className="eval-report-brand"><ReportLogo /><span>EvalPi</span></div><span className="eval-report-demo">示例报告 · 演示数据</span></div>
      <div className="eval-report-cover">
        <p className="eval-report-eyebrow">EVALUATION / 003</p>
        <h1>售后客服 Agent<span>{completed ? '评测与调优报告' : '基线评测报告'}</span></h1>
        <p className="eval-report-subtitle">{completed ? '从原始表现到候选验证，记录改善与尚待解决的问题。' : '建立可比较的起点，核验任务完成中的关键问题。'}</p>
      </div>
      <dl className="eval-report-meta"><div><dt>评测范围</dt><dd>申请提交 · 政策判断 · 异常处理</dd></div><div><dt>报告版本</dt><dd>{completed ? '03 · 候选版本验证后' : '01 · 基线评测完成'}</dd></div><div><dt>生成时快照</dt><dd>{snapshot}</dd></div></dl>
    </header>

    <section className="eval-report-section eval-report-verdict" aria-labelledby="eval-report-verdict-title">
      <p className="eval-report-eyebrow">01 / 本轮结论</p>
      <h2 id="eval-report-verdict-title">{verdictTitle}</h2>
      <p>{completed ? `候选版本在同一评测集上的原始自动完成率为 91.7%，成本与平均响应时间均在约定范围内。${hasHumanReview ? '人工判断独立保留，自动评分尚未依据本次复核重新校准，当前数值不代表人工验收结论。' : '重复申请的并发场景与政策例外条款仍需补充验证。'}是否采用由你和研发共同判断。` : `基线自动评分通过 276 / 360 次执行。${hasHumanReview ? '本次人工复核独立记录，自动评分尚未重算；后续处理以人工判断和核查结果为依据。' : '优先核验提交结果、重复申请和政策边界问题，再在同一评测集上比较候选版本。'}当前尚无候选结果。`}</p>
      {hasPendingReview && <p className="eval-report-review-summary">未闭环复核：{pendingIds.length} 个案例。生成时仍为待核查状态，报告不会将其自动记为已修复或无问题。</p>}
      {completed && !hasPendingReview && hasHumanReview && remainingIds.length > 0 && <p className="eval-report-review-summary">仍需补充验证的代表场景：{remainingIds.join('、')}。人工确认的问题与候选版本复测结果分开记录。</p>}
    </section>

    <section className="eval-report-section" aria-labelledby="eval-report-metrics-title">
      <div className="eval-report-section-title"><h2 id="eval-report-metrics-title">效果与代价</h2><span>{completed ? '候选版本' : '原始版本'}</span></div>
      <div className="eval-report-metrics">{metrics.map((metric, index) => <div className={`eval-report-metric${index === 0 ? ' primary' : ''}`} key={metric.label}><p>{metric.label}</p><div className="eval-report-metric-number"><strong>{completed ? metric.candidate : metric.baseline}</strong><span>{metric.unit}</span></div><span className="eval-report-metric-note">{metric.note}</span>{completed && <span className="eval-report-delta">{metric.delta}</span>}</div>)}</div>
      <p className="eval-report-scoring-note">原始自动评分口径{hasHumanReview ? ' · 尚未重算人工校准后的分数' : ' · 人工复核结论单独记录'}。</p>
      <Comparison completed={completed} />
      {completed && <div className="eval-report-blind"><div><span className="eval-report-eyebrow">独立盲测</span><h3>新样本上的表现</h3></div><div className="eval-report-blind-score"><strong>90.0<span>%</span></strong><span>162 / 180 次通过</span></div><p>60 个独立 Case，各运行 3 次。原始版本在同集上为 75.0%。样本在调优期间隐藏，候选冻结后验证；本组单独统计，保留原始自动评分。</p></div>}
    </section>

    <section className="eval-report-section" aria-labelledby="eval-report-evidence-title">
      <p className="eval-report-eyebrow">02 / 问题证据</p>
      <div className="eval-report-section-title"><h2 id="eval-report-evidence-title">关键案例与判定依据</h2><span>3 个代表案例</span></div>
      <p className="eval-report-section-intro">保留行为、证据与判定依据。展开案例，可以继续查看研发需要的细节。</p>
      <Evidence completed={completed} review={review} />
    </section>

    <section className="eval-report-section" aria-labelledby="eval-report-next-title">
      <p className="eval-report-eyebrow">03 / 后续行动</p>
      <h2 id="eval-report-next-title">{hasHumanReview ? '依据复核结论继续验证' : completed ? '采用前需要完成的工作' : '下一轮调优的优先事项'}</h2>
      <ol className="eval-report-actions">{actions.map(([owner, action], index) => <li key={owner}><span className="eval-report-action-number">0{index + 1}</span><div><strong>{owner}</strong><p>{action}</p></div></li>)}</ol>
    </section>

    <section className="eval-report-section eval-report-method" id="report-method" aria-labelledby="eval-report-method-title">
      <p className="eval-report-eyebrow">04 / 方法与范围</p>
      <h2 id="eval-report-method-title">统计口径与验证条件</h2>
      <dl><div><dt>统计口径</dt><dd>120 个独立 Case × 3 次执行。通过率按执行次数计算，不把 360 次执行记成 360 个独立 Case。</dd></div><div><dt>判定方式</dt><dd>业务状态检查与 LLM 评分结合。比较时固定评测标准 v1.2、打分器与数据集版本。</dd></div><div><dt>运行条件</dt><dd>每次尝试恢复预设初始状态，隔离跨 Case 的对话与临时记忆；单个多轮 Case 内保留上下文。</dd></div><div><dt>结论范围</dt><dd>测试环境与当前覆盖场景。平均延迟不代表最慢响应；盲测通过也不代表所有真实场景都已覆盖。</dd></div></dl>
      {hasHumanReview && <p className="eval-report-scoring-note">人工校准：本报告锁定生成时的复核快照，原始自动评分保持不变。{hasHumanClear ? '人工判定无问题的案例保留结论，原始自动证据仅供追溯。' : '人工确认与自动复测分开标记。'}重新校准后的指标需要另行生成。</p>}
      <aside className="eval-report-limitations"><strong>关于这份示例</strong><p>所有指标、运行记录与判断均为前端演示数据，未调用真实模型或售后系统。本文用于展示报告的阅读结构。</p></aside>
    </section>

    <nav className="eval-report-appendices" aria-label="报告附录"><p className="eval-report-eyebrow">05 / 附录</p><h2>完整结果与运行记录</h2><a href={`./EvalPi_${snapshot}_case_results.csv`} download onClick={event => { if (onAppendix) { event.preventDefault(); onAppendix('cases'); } }}><span><strong>逐条评测结果</strong><small>完整 Case 与各次尝试的判定</small></span><span className="eval-report-filetype">CSV ↗</span></a><a href={`./EvalPi_${snapshot}_traces.jsonl`} download onClick={event => { if (onAppendix) { event.preventDefault(); onAppendix('traces'); } }}><span><strong>运行 Trace</strong><small>模型回复、工具调用与状态核验</small></span><span className="eval-report-filetype">JSONL ↗</span></a><p className="eval-report-appendix-note">离线阅读时，请将报告和对应快照的两份附录保存在同一文件夹。</p></nav>
    <footer className="eval-report-footer"><span>EvalPi · 评测报告</span><span>保留证据，记录每一次改善。</span></footer>
  </article>;
}

export function buildReportHtml(completed: boolean, review?: ReviewSubmission | null, snapshotId?: string, embeddedFontCss = ''): string {
  const title = completed ? '售后客服 Agent · 调优与验证报告' : '售后客服 Agent · 基线评测报告';
  const body = renderToStaticMarkup(<ReportView completed={completed} review={review} snapshotId={snapshotId} />);
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${title} | EvalPi 示例</title><style>${reportThemeCss}\n${reportLayoutCss}\n${reportCompositionCss}\n${embeddedFontCss}</style></head><body class="eval-report-standalone">${body}</body></html>`;
}
