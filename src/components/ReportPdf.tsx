import { Document, Font, Link, Page, StyleSheet, Text as PdfText, View, Svg, Path, pdf } from '@react-pdf/renderer';
import { Children, type ComponentProps, type ReactNode } from 'react';
import type { ReviewSubmission } from './ReviewPanel';
import reportTheme from '../design-system/reports/theme.json';
import { evalPiLogoBlack, evalPiLogoShapes, evalPiLogoViewBox, evalPiWatermarkOpacity } from '../lib/brandLogo';

export type ReportPdfProps = {
  completed: boolean;
  review?: ReviewSubmission | null;
  snapshotId?: string;
};

const FONT = reportTheme.pdfFonts.serif.family;
const LATIN_FONT = reportTheme.pdfFonts.latin.family;
const MONO_FONT = reportTheme.pdfFonts.mono.family;
const CODE_FONT = reportTheme.pdfFonts.code.family;
let registeredFontBase: string | undefined;

/** The same local font files are used for the browser preview and downloadable PDF. */
export function registerReportFonts(basePath = '/fonts') {
  const base = basePath.replace(/\/$/, '');
  if (registeredFontBase === base) return;
  for (const font of Object.values(reportTheme.pdfFonts)) {
    Font.register({ family: font.family, fonts: font.files.map(face => ({ src: `${base}/${face.file}`, fontWeight: face.weight })) });
  }
  // Permit CJK line breaks while keeping ASCII words and filenames together.
  Font.registerHyphenationCallback(word => word.match(/[\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]|[^\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]+/gu) ?? [word]);
  registeredFontBase = base;
}

const palette = {
  canvas: reportTheme.colors.canvas, paper: reportTheme.colors.paper, ink: reportTheme.colors.ink, copy: reportTheme.colors.copy,
  muted: reportTheme.colors.muted, line: reportTheme.colors['pdf-line'], blue: reportTheme.colors.positive, terracotta: reportTheme.colors.terracotta,
  baseline: reportTheme.colors.baseline, accent: reportTheme.colors.accent, pending: reportTheme.colors.pending,
};

/** React-PDF does not resolve browser font stacks: each script gets an explicit font. */
function Text({ children, latinFont = LATIN_FONT, ...props }: ComponentProps<typeof PdfText> & { children?: ReactNode; latinFont?: string }) {
  return <PdfText {...props}>{Children.map(children, child => {
    if (typeof child !== 'string' && typeof child !== 'number') return child;
    return String(child).split(/([\u0000-\u024f]+)/u).filter(Boolean).map((run, index) =>
      <PdfText key={index} style={{ fontFamily: /^[\u0000-\u024f]+$/u.test(run) ? latinFont : FONT }}>{run}</PdfText>);
  })}</PdfText>;
}

const s = StyleSheet.create({
  page: { paddingTop: 34, paddingHorizontal: 44, paddingBottom: 58, fontFamily: FONT, fontSize: 10, lineHeight: 1.65, color: palette.copy, backgroundColor: palette.paper },
  brandline: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 23, paddingBottom: 13, borderBottomWidth: 0.5, borderBottomColor: palette.line },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  brandName: { fontSize: 18, color: palette.ink, lineHeight: 1 },
  demo: { fontSize: 8, color: palette.muted },
  coverHeading: { marginBottom: 2 },
  eyebrow: { fontSize: 8, letterSpacing: 0.6, color: palette.accent, marginBottom: 10, lineHeight: 1.4 },
  title: { fontSize: 31, lineHeight: 1.32, fontWeight: 500, letterSpacing: -0.6, color: palette.ink, marginBottom: 3 },
  reportKind: { fontSize: 28, lineHeight: 1.38, fontWeight: 400, letterSpacing: -0.5, color: palette.copy, marginBottom: 13 },
  subtitle: { fontSize: 10, color: palette.copy, lineHeight: 1.7, marginBottom: 18 },
  metadata: { flexDirection: 'row', gap: 24, borderTopWidth: 0.5, borderTopColor: palette.line, borderBottomWidth: 0.5, borderBottomColor: palette.line, paddingVertical: 11, marginBottom: 20 },
  metaItem: { flex: 1 },
  metaLabel: { fontSize: 8, color: palette.muted, marginBottom: 3 },
  metaValue: { fontSize: 9 },
  h2: { fontSize: 16, fontWeight: 500, lineHeight: 1.45, marginBottom: 9, color: palette.ink },
  h3: { fontSize: 13, fontWeight: 500, lineHeight: 1.5, marginBottom: 8, color: palette.ink },
  paragraph: { fontSize: 10, lineHeight: 1.8 },
  fine: { fontSize: 8, color: palette.muted, lineHeight: 1.65 },
  section: { marginBottom: 16 },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 },
  metrics: { flexDirection: 'row', borderTopWidth: 0.5, borderTopColor: palette.line, borderBottomWidth: 0.5, borderBottomColor: palette.line, paddingVertical: 15, marginTop: 19, marginBottom: 20 },
  metric: { width: '25%', paddingRight: 9 },
  metricDivider: { paddingLeft: 10 },
  metricLabel: { fontSize: 9, color: palette.copy, marginBottom: 9 },
  metricValue: { fontSize: 28, fontWeight: 400, letterSpacing: -0.5, lineHeight: 1.15, color: palette.ink },
  unit: { fontSize: 8, fontWeight: 400, letterSpacing: 0 },
  metricNote: { fontSize: 7.5, color: palette.muted, marginTop: 6 },
  delta: { fontSize: 7.5, color: palette.muted, marginTop: 3 },
  chartTitle: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 9 },
  chartLabel: { fontSize: 9, fontWeight: 500, color: palette.ink },
  barRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 9 },
  rowLabel: { width: 65, fontSize: 9 },
  track: { flex: 1, height: 12, backgroundColor: palette.canvas, position: 'relative' },
  fill: { height: 12, backgroundColor: palette.baseline },
  target: { position: 'absolute', top: -3, bottom: -3, left: '90%', borderLeftWidth: 0.7, borderLeftColor: palette.ink },
  barValue: { width: 51, textAlign: 'right', fontSize: 11, fontWeight: 500, color: palette.blue },
  holdout: { borderTopWidth: 0.5, borderTopColor: palette.line, paddingTop: 13, marginTop: 17 },
  holdoutTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 },
  holdoutValue: { fontSize: 24, fontWeight: 400, color: palette.blue },
  pageTitle: { fontSize: 26, fontWeight: 500, lineHeight: 1.35, marginBottom: 10, letterSpacing: -0.5, color: palette.ink },
  intro: { fontSize: 10, lineHeight: 1.75, color: palette.copy, marginBottom: 20 },
  evidence: { borderTopWidth: 0.5, borderTopColor: palette.line, paddingTop: 12, paddingBottom: 13 },
  evidenceTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 },
  caseId: { fontSize: 8, letterSpacing: 0.8, color: palette.muted },
  status: { fontSize: 8, color: palette.terracotta },
  evidenceText: { fontSize: 9.5, lineHeight: 1.7, marginBottom: 7 },
  evidenceDetail: { flexDirection: 'row', marginTop: 4 },
  detailLabel: { width: 57, fontSize: 8, color: palette.muted, paddingTop: 1 },
  detailText: { flex: 1, fontSize: 9, lineHeight: 1.65 },
  trace: { backgroundColor: palette.canvas, paddingVertical: 8, paddingHorizontal: 11, fontSize: 7.7, lineHeight: 1.65, marginTop: 10 },
  note: { borderTopWidth: 0.5, borderTopColor: palette.line, backgroundColor: palette.canvas, padding: 8, marginTop: 10 },
  methodRow: { flexDirection: 'row', paddingVertical: 9, borderBottomWidth: 0.5, borderBottomColor: palette.line },
  methodLabel: { width: 66, fontSize: 8, color: palette.muted, paddingTop: 1 },
  methodValue: { flex: 1, fontSize: 9, lineHeight: 1.7 },
  actionRow: { flexDirection: 'row', marginTop: 9 },
  actionNumber: { width: 30, fontSize: 9, color: palette.terracotta },
  actionContent: { flex: 1 },
  actionOwner: { fontSize: 9, fontWeight: 500, marginBottom: 2, color: palette.ink },
  actionText: { fontSize: 9, lineHeight: 1.7 },
  appendix: { borderTopWidth: 0.5, borderTopColor: palette.line, paddingTop: 8, marginTop: 9 },
  appendixTitle: { fontSize: 9, fontWeight: 500, marginBottom: 2, color: palette.ink },
  fileLink: { fontFamily: CODE_FONT, fontSize: 7.4, color: palette.blue, textDecoration: 'none' },
  // Explicit A4 coordinates avoid bottom anchoring against the pre-pagination
  // content height when React-PDF lays out fixed elements.
  footer: { position: 'absolute', left: 44, right: 44, top: 793, height: 23, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', borderTopWidth: 0.5, borderTopColor: palette.line, paddingTop: 9 },
  footerText: { fontSize: 7, lineHeight: 1.3, color: palette.muted },
});

function EvalPiLogo({ width, colored = false }: { width: number; colored?: boolean }) {
  return <Svg width={width} height={width * 945 / 1001.5} viewBox={evalPiLogoViewBox}>
    {evalPiLogoShapes.map(shape => <Path key={shape.fill} d={shape.d} fill={colored ? shape.fill : evalPiLogoBlack} fillOpacity={colored ? evalPiWatermarkOpacity : 1} />)}
  </Svg>;
}

function ReportPage({ children, pageNumber }: { children: ReactNode; pageNumber: 1 | 2 | 3 }) {
  return <Page size="A4" style={s.page}>
    <View style={s.brandline}><View style={s.brand}><EvalPiLogo width={21 * 1001.5 / 945} /><Text style={s.brandName}>EvalPi</Text></View><Text style={s.demo}>示例报告 · 演示数据</Text></View>
    {children}
    <View style={s.footer} fixed>
      <Text style={s.footerText}>EvalPi · 售后客服 Agent 评测报告</Text>
      <Text style={s.footerText} latinFont={MONO_FONT}>{`0${pageNumber} / 03`}</Text>
    </View>
  </Page>;
}

const metrics = [
  { label: '任务完成率', baseline: '76.7', candidate: '91.7', unit: '%', note: '目标 ≥ 90%', delta: '+15.0 个百分点' },
  { label: '平均任务成本', baseline: '0.12', candidate: '0.14', unit: '元', note: '上限 ¥0.15', delta: '+¥0.02 / 次' },
  { label: '平均响应时间', baseline: '3.8', candidate: '4.2', unit: '秒', note: '上限 5 秒', delta: '+0.4 秒 / 次' },
  { label: '通过的执行', baseline: '276', candidate: '330', unit: ' / 360', note: '120 个 Case × 3 次', delta: '+54 次通过' },
];

function ScoreBar({ label, value, candidate = false }: { label: string; value: number; candidate?: boolean }) {
  return <View style={s.barRow}><Text style={s.rowLabel}>{label}</Text><View style={s.track}><View style={[s.fill, { width: `${value}%`, backgroundColor: candidate ? palette.blue : palette.baseline }]} /><View style={s.target} /></View><Text style={s.barValue}>{value.toFixed(1)}%</Text></View>;
}

const cases = [
  {
    id: 'CS-014', title: '提交失败，回复却称已完成',
    finding: '申请接口超时，测试后台没有新增记录；原始版本仍回复「已为您提交申请」。',
    standard: '工具结果、后台状态与对客回复一致，只有确认创建成功后才承诺完成。',
    improvement: '增加提交结果核验；状态未知时说明情况并补查后台。候选回测显示改善，记录仍需结合人工判断验收。',
    trace: 'create_after_sale → timeout  /  backend.application → null\nagent.reply → 已为您提交申请',
    evidence: '基线 CS-014 / 第 2 次尝试；候选复测记录单独保留。',
  },
  {
    id: 'CS-027', title: '同一订单重复创建售后',
    finding: '用户重复确认后，原始版本生成两张有效售后单；同一订单、同一诉求未保持幂等。',
    standard: '先查询已有售后状态，防止重复创建有效申请。',
    improvement: '增加提交前查询与请求标识。并发重试仍需补充验证，当前证据不足以确认所有重复请求均被处理。',
    evidence: '基线 CS-027；待补充并发重试场景与对应后台状态。',
  },
  {
    id: 'CS-032', title: '混淆退货期限与质量售后',
    finding: '购买 12 天的商品出现质量问题，Agent 仅依据七天无理由期限拒绝售后。',
    standard: '区分无理由退货与质量售后，查询当前适用政策并确认必要信息。',
    improvement: '拆分两类政策的判断路径；商家例外条款尚未补齐，相关结论保持待定，补齐规则后再验证。',
    evidence: '政策检索 CS-032；待补充商家例外条款。',
  },
];

function reviewState(id: string, review?: ReviewSubmission | null) {
  const decision = review?.decisions[id];
  if (decision === 'clear') return { label: '人工判定无问题', color: palette.blue, pending: false, clear: true, human: true };
  if (decision === 'issue') return { label: '人工确认有问题', color: palette.accent, pending: false, clear: false, human: true };
  if (decision === 'recheck' || review?.uncheckedIds.includes(id)) return { label: '待核查', color: palette.pending, pending: true, clear: false, human: false };
  return { label: '自动评测发现', color: palette.muted, pending: false, clear: false, human: false };
}

/** Three pages: decision, representative evidence, and reproducible scope. */
export function ReportPdfDocument({ completed, review, snapshotId = completed ? 'candidate' : 'baseline' }: ReportPdfProps) {
  const safeSnapshotId = snapshotId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'snapshot';
  const caseFile = `EvalPi_${safeSnapshotId}_case_results.csv`;
  const traceFile = `EvalPi_${safeSnapshotId}_traces.jsonl`;
  const reviewCount = review ? Object.keys(review.decisions).length : 0;
  const recheckCount = review ? Object.values(review.decisions).filter(value => value === 'recheck').length + review.uncheckedIds.filter(id => !review.decisions[id]).length : 0;
  return <Document title={`售后客服 Agent · ${completed ? '调优与验证' : '基线评测'}报告`} author="EvalPi" subject="前端演示报告：指标与运行记录均为示例" language="zh-CN">
    <ReportPage pageNumber={1}>
      <View style={s.coverHeading}>
        <Text style={s.eyebrow} latinFont={MONO_FONT}>EVALUATION / 003</Text>
        <Text style={s.title}>售后客服 Agent</Text>
        <Text style={s.reportKind}>{completed ? '评测与调优报告' : '基线评测报告'}</Text>
        <Text style={s.subtitle}>{completed ? '从原始表现到候选验证，记录改善与尚待解决的问题。' : '建立可比较的起点，核验任务完成中的关键问题。'}</Text>
      </View>
      <View style={s.metadata}>
        <View style={s.metaItem}><Text style={s.metaLabel}>评测范围</Text><Text style={s.metaValue}>申请提交 · 政策判断 · 异常处理</Text></View>
        <View style={s.metaItem}><Text style={s.metaLabel}>报告阶段</Text><Text style={s.metaValue}>{completed ? '候选版本验证后 · 自动评分口径' : '基线评测完成 · 尚无候选结果'}</Text></View>
      </View>
      <Text style={s.eyebrow} latinFont={MONO_FONT}>01 / 本轮结论</Text>
      <Text style={s.h2}>{completed ? review ? '自动指标达标，人工校准待完成。' : '自动指标达标，两个场景仍需验证。' : '完成率未达标，优先核验提交结果。'}</Text>
      <Text style={s.paragraph}>{completed ? '候选版本在同一评测集上的完成率为 91.7%，成本与平均响应时间均在约定范围内。并发重复申请与政策例外条款仍需补充验证，是否采用由产品经理和研发共同判断。' : '基线通过 276 / 360 次执行。优先处理提交结果核验、重复申请和政策边界问题，再比较候选版本。当前报告仅展示原始版本的表现。'}</Text>
      <View style={s.metrics}>
        {metrics.map((metric, index) => <View style={index ? [s.metric, s.metricDivider] : s.metric} key={metric.label}>
          <Text style={s.metricLabel}>{metric.label}</Text>
          <Text style={[s.metricValue, { color: index === 0 ? palette.blue : palette.ink }]}>{completed ? metric.candidate : metric.baseline}<Text style={s.unit}>{metric.unit}</Text></Text>
          <Text style={s.metricNote}>{metric.note}</Text>
          {completed && <Text style={[s.delta, { color: index === 0 ? palette.blue : palette.muted }]}>{metric.delta}</Text>}
        </View>)}
      </View>
      <View>
        <View style={s.chartTitle}><Text style={s.chartLabel}>同集比较 · 任务完成率</Text><Text style={s.fine}>竖线为目标 90%</Text></View>
        <ScoreBar label="原始版本" value={76.6667} />
        {completed && <ScoreBar label="候选版本" value={91.6667} candidate />}
        <Text style={s.fine}>120 个 Case，各独立运行 3 次。按执行次数计算通过率，偶发失败保留记录。</Text>
      </View>
      {completed && <View style={s.holdout}>
        <View style={s.holdoutTop}><View><Text style={s.eyebrow}>独立盲测</Text><Text style={s.h3}>新样本上的表现</Text></View><Text style={s.holdoutValue}>90.0<Text style={s.unit}>%</Text></Text></View>
        <Text style={s.fine}>候选 162 / 180 次通过；原始 135 / 180（75.0%）。60 个独立 Case × 3 次；调优期间隐藏样本，候选冻结后验证，与上方数据分开统计。</Text>
      </View>}
    </ReportPage>

    <ReportPage pageNumber={2}>
      <Text style={s.eyebrow} latinFont={MONO_FONT}>02 / 问题证据</Text>
      <Text style={s.pageTitle}>关键案例与判定依据</Text>
      <Text style={s.intro}>3 个代表案例，保留行为、判定依据与人工结论。逐条结果和完整 Trace 在附录中提供。</Text>
      {cases.map(item => {
        const state = reviewState(item.id, review);
        const progress = state.clear ? '保留人工「无问题」结论。本条自动发现只作为历史记录，不列入已确认问题，也不宣称已修复。' : state.pending ? '交由 Agent 继续核查，当前保持待定。未获得充分证据前，不进入自动修复，不宣称已解决。' : completed ? item.improvement : '等待后续归因与调优。基线报告未包含候选改动或候选验证结果。';
        return <View key={item.id} style={s.evidence} wrap={false}>
          <View style={s.evidenceTop}><Text style={s.caseId} latinFont={MONO_FONT}>{item.id}</Text><Text style={[s.status, { color: state.color }]}>{state.label}</Text></View>
          <Text style={s.h3}>{item.title}</Text>
          <Text style={s.evidenceText}>{item.finding}</Text>
          <View style={s.evidenceDetail}><Text style={s.detailLabel}>判定依据</Text><Text style={s.detailText}>{item.standard}</Text></View>
          <View style={s.evidenceDetail}><Text style={s.detailLabel}>{state.clear || state.pending ? '复核结果' : completed ? '当前进展' : '后续处理'}</Text><Text style={s.detailText}>{progress}</Text></View>
          {item.trace && <Text style={s.trace} latinFont={CODE_FONT}>{item.trace}</Text>}
          <Text style={[s.fine, { marginTop: 7 }]}>证据：{completed ? item.evidence : item.evidence.replace('；候选复测记录单独保留。', '。')}</Text>
        </View>;
      })}
      <View style={s.note} wrap={false}>
        <Text style={s.fine}>{review ? `本批已选择 ${reviewCount} 项，另有未选择 ${review.uncheckedIds.length} 项；共 ${recheckCount} 项交由 Agent 核查。人工判定保留，未选择项也进入核查，证据不足继续待定。` : '本批尚未提交人工复核。自动发现不等于人工确认；支持批量确认有问题、判定无问题或交由 Agent 核查。'}</Text>
      </View>
    </ReportPage>

    <ReportPage pageNumber={3}>
      <Text style={s.eyebrow} latinFont={MONO_FONT}>03 / 方法与后续行动</Text>
      <Text style={s.pageTitle}>统计口径与验证条件</Text>
      <Text style={s.intro}>保留可比较的条件，也明确尚未验证的部分。</Text>
      <View style={s.section}>
        {[
          ['统计口径', '基线集 120 个独立 Case × 3 次，共 360 次执行。通过率按执行计数；360 次执行不等于 360 个独立 Case。'],
          ['判定方式', '业务状态检查与 LLM 评分结合。固定评测标准 v1.2、打分器和数据集版本。人工标签与自动评分分别记录，校准后需重算。'],
          ['运行条件', '每次尝试恢复预设初始状态，隔离跨 Case 对话和临时记忆；同一多轮 Case 内保留上下文。'],
          ['盲测范围', completed ? '独立 60 个 Case × 3 次，原始与候选使用同一冻结集合。调优期间隐藏样本，候选冻结后验证。' : '盲测验证尚未完成，本阶段不提供候选表现或盲测验收结论。'],
          ['结论范围', '结论适用于测试环境与当前覆盖场景。平均延迟不代表最慢响应；当前通过不能证明所有真实场景均已覆盖。'],
        ].map(([label, content]) => <View key={label} style={s.methodRow}><Text style={s.methodLabel}>{label}</Text><Text style={s.methodValue}>{content}</Text></View>)}
      </View>
      <Text style={s.h2}>{completed ? '采用前需要完成的工作' : '下一轮调优的优先事项'}</Text>
      {(completed ? [
        ['研发', '对仍确认有问题的案例补充验证，重点核验并发重试与幂等条件；待核查项先补证据。'],
        ['产品经理', '补齐商家质量售后例外条款，处理有争议的预期；保留已提交的人工判定。'],
        ['共同确认', '查看补充验证与人工校准后的统计，再决定是否采用候选版本。'],
      ] : [
        ['优先处理', '依据复核结论推进问题归因；提交结果核验与超时后状态查询优先。'],
        ['继续调优', '在授权副本中调整实现，保留原始版本；待核查项先补齐证据。'],
        ['独立验证', '候选版本冻结后，完成同集回归与独立盲测，再讨论是否达到验收要求。'],
      ]).map(([owner, action], index) => <View style={s.actionRow} key={owner}><Text style={s.actionNumber} latinFont={MONO_FONT}>0{index + 1}</Text><View style={s.actionContent}><Text style={s.actionOwner}>{owner}</Text><Text style={s.actionText}>{action}</Text></View></View>)}
      <View style={{ marginTop: 18 }}>
        <Text style={s.eyebrow}>附录 / 同一快照</Text>
        <View style={s.appendix}><Text style={s.appendixTitle}>逐条评测结果 · CSV</Text><Link style={s.fileLink} src={`./${caseFile}`}>{caseFile}</Link></View>
        <View style={s.appendix}><Text style={s.appendixTitle}>运行 Trace · JSONL</Text><Link style={s.fileLink} src={`./${traceFile}`}>{traceFile}</Link></View>
        <Text style={[s.fine, { marginTop: 8 }]}>附录与报告使用同一快照。离线阅读请将三份文件保存在同一文件夹；阅读器不支持相对链接时，可按文件名直接打开。</Text>
      </View>
      <View style={s.note}><Text style={s.fine}>关于这份示例：全部指标、运行记录与判断均为前端演示数据，未调用真实模型或售后系统。</Text></View>
    </ReportPage>
  </Document>;
}

export async function createReportPdf(completed: boolean, review?: ReviewSubmission | null, snapshotId?: string): Promise<Blob> {
  registerReportFonts();
  return pdf(<ReportPdfDocument completed={completed} review={review} snapshotId={snapshotId} />).toBlob();
}
