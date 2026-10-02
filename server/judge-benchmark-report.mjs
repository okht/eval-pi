import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const pct = value => value === null || value === undefined ? '—' : `${(100 * value).toFixed(1)}%`;
const rate = metric => metric ? `${metric.numerator}/${metric.denominator} · ${pct(metric.rate)}` : '—';
const ci = metric => metric?.wilson95?.lower !== null && metric?.wilson95?.lower !== undefined ? `${pct(metric.wilson95.lower)} - ${pct(metric.wilson95.upper)}` : '—';
const clip = (value, limit = 220) => {
  const text = String(value ?? '').replace(/\s+/g, ' ');
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};
const names = { pass: '无违规 / pass', fail: '有违规 / fail', pending: '证据不足 / pending', error: '异常 / 取消', not_run: '未运行' };
const csv = value => `"${String(value ?? '').replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""')}"`;

export function buildReviewQueue(cases, trials, repeats = 2) {
  return cases.flatMap(item => {
    const attempts = trials.filter(trial => trial.caseId === item.id).sort((a, b) => a.trial - b.trial);
    const disagreements = attempts.filter(trial => trial.status !== 'completed' || trial.verdict !== item.referenceVerdict);
    const unstable = new Set(attempts.filter(trial => trial.status === 'completed').map(trial => trial.verdict)).size > 1;
    const missingTrials = Array.from({ length: repeats }, (_, index) => index + 1).filter(repeat => !attempts.some(trial => trial.trial === repeat));
    if (!disagreements.length && !unstable && !missingTrials.length) return [];
    return [{ caseId: item.id, source: item.source, split: item.split, labelOrigin: item.labelOrigin,
      status: 'needs_human_review', referenceVerdict: item.referenceVerdict, reference: item.reference,
      request: item.request, attempts, unstable, missingTrials,
      note: '与固定参考标签不一致的候选。尚未经本次独立人工复核；保留原始标签与评分，不自动改写。' }];
  });
}

export async function createJudgeBenchmarkReport({ run, cases, manifest, directory }) {
  await mkdir(directory, { recursive: true });
  const summary = run.summary;
  const heldout = summary.bySplit.heldout;
  const development = summary.bySplit.development;
  const contract = summary.bySplit.contract;
  const human = summary.byLabelOrigin.human;
  const heldoutIds = new Set(cases.filter(item => item.split === 'heldout').map(item => item.id));
  const heldoutInvoked = run.trials.some(trial => heldoutIds.has(trial.caseId));
  const review = buildReviewQueue(cases, run.trials, run.repeats);
  const model = manifest.judgeInfo?.model ?? run.judgeInfo?.model ?? '未记录';
  const spec = manifest.judgeInfo?.specification ?? run.judgeInfo?.specification;
  const groups = [['人工标签 · 开发集', development], ['人工标签 · 保留验收集', heldout], ['构造案例 · 证据契约', contract]].filter(([, value]) => value);
  const rows = groups.map(([label, value]) => `<tr><td>${label}</td><td>${value.caseCount}</td><td>${rate(value.primary.accuracy)}</td><td>${value === contract ? '不估计（构造对照）' : ci(value.primary.accuracy)}</td><td>${rate(value.repeatStability.agreement)}</td></tr>`).join('');
  const matrix = group => !group ? '' : `<table><thead><tr><th>参考标签 \ Judge</th>${['pass', 'fail', 'pending', 'error', 'not_run'].map(key => `<th>${names[key]}</th>`).join('')}</tr></thead><tbody>${['pass', 'fail', 'pending'].map(key => `<tr><td>${names[key]}</td>${['pass', 'fail', 'pending', 'error', 'not_run'].map(predicted => `<td>${group.primary.confusionMatrix[key][predicted]}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const diagnostics = group => !group ? '' : `<div class="diagnostics"><div>误报<span>${rate(group.binaryDetection.falsePositive)}</span></div><div>漏判<span>${rate(group.binaryDetection.falseNegative)}</span></div><div>违规案例待定<span>${rate(group.binaryDetection.failAbstention)}</span></div><div>二元判定覆盖率<span>${rate(group.binaryDetection.coverage)}</span></div></div>`;
  const heldoutReviews = review.filter(item => item.split === 'heldout');
  const representatives = ['pass', 'fail'].map(verdict => heldoutReviews.find(item => item.referenceVerdict === verdict)).filter(Boolean);
  if (representatives.length < 2) representatives.push(...review.filter(item => !representatives.includes(item)).slice(0, 2 - representatives.length));
  const caseBlocks = representatives.map(item => {
    const attempt = item.attempts.find(row => row.verdict !== item.referenceVerdict || row.status !== 'completed') ?? { status: 'not_run', reason: '该案例有计划轮次尚未完成。' };
    return `<div class="case"><div class="case-top"><strong>${esc(item.caseId)}</strong><span>${esc(item.split)} · 参考 ${esc(item.referenceVerdict)} / 首个不一致 ${esc(attempt?.verdict ?? attempt?.status)}</span></div><p class="question">${esc(clip(item.request.case.input?.question ?? item.request.case.name, 180))}</p><p><b>被评回复</b> ${esc(clip(item.request.output?.answer ?? JSON.stringify(item.request.output), 330))}</p><p><b>Judge 理由</b> ${esc(clip(attempt?.reason, 330))}</p><p class="muted">完整原始材料、人工标注片段与各轮理由见 review-queue.json；该分歧尚未由独立人工裁决。</p></div>`;
  }).join('');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EvalPi · Judge 可靠性初验</title><style>
  *{box-sizing:border-box}body{margin:0;background:#f3f2f0;color:#26303c;font:13px/1.8 'Microsoft YaHei','Segoe UI',sans-serif}.page{max-width:890px;margin:0 auto;padding:46px 54px;background:#faf9f6}header{display:flex;align-items:center;border-bottom:1px solid #c8c9c8;padding-bottom:16px;gap:12px}header strong{font:26px Georgia,serif}header small{margin-left:auto;color:#71767a;font:10px Consolas,monospace}.eyebrow{font:10px/1.8 Consolas,monospace;color:#985a40;letter-spacing:1px;margin:25px 0 8px}h1{font:34px/1.5 Georgia,SimSun,serif;margin:0 0 12px}h2{font:23px/1.5 Georgia,SimSun,serif;margin:0 0 14px}p{margin:9px 0}.lede{max-width:650px;color:#626b74}.callout{border-left:3px solid #52687a;background:#edf0f0;padding:12px 17px;margin:22px 0;font-size:12px}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:22px;margin:24px 0}.metrics strong{display:block;font:34px/1.4 Georgia,serif;color:#4f667a}.metrics small{display:block;color:#71767a;font-size:10px}.section{border-top:1px solid #c9ccc9;padding-top:18px;margin-top:24px}table{width:100%;border-collapse:collapse;font-size:10px;line-height:1.8;margin:16px 0}th{text-align:left;color:#636b73;font-weight:500;border-bottom:1px solid #949d9f;padding:9px 5px}td{border-bottom:1px solid #d7dbd8;padding:10px 5px;vertical-align:top}td:first-child{color:#313f4b}th:not(:first-child),td:not(:first-child){text-align:right}.muted{color:#737d82;font-size:10px}.diagnostics{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:15px 0;font-size:10px;color:#68757d}.diagnostics span{display:block;font-size:13px;color:#394b5a;margin-top:3px}.case{padding:14px 0;border-top:1px solid #d1d5d2;break-inside:avoid;font-size:11px;line-height:1.8}.case-top{display:flex;gap:12px;align-items:baseline}.case-top strong{font:11px Consolas,monospace}.case-top span{font-size:10px;color:#925b43}.question{font-size:12px;font-weight:600}.links{display:flex;flex-wrap:wrap;gap:10px 25px}a{color:#48637a;text-underline-offset:3px}.fingerprint{word-break:break-all;font:9px/1.8 Consolas,monospace}.steps{padding-left:19px;font-size:11px;line-height:1.9}.steps li{margin:8px 0}.footer{border-top:1px solid #c8ccc9;padding-top:14px;margin-top:28px;color:#7b8386;font-size:9px}
  @media print{@page{size:A4;margin:17mm 17mm 18mm}body{background:#faf9f6;font-size:11px}.page{padding:0;max-width:none;break-after:page}.page:last-child{break-after:auto}h1{font-size:30px}header{padding-bottom:12px}.eyebrow{margin-top:21px}.section{margin-top:20px}.metrics{margin:20px 0}table{font-size:9px}th,td{padding:8px 4px}.callout{margin:18px 0}.case{font-size:10px}.muted{font-size:9px}a{color:#48637a}}
  @media print{body{font-size:10.5px;line-height:1.65}.page{break-after:auto}.page+.page{break-before:page}header{break-inside:avoid}h1{font-size:28px}h2{font-size:21px;margin-bottom:11px}.eyebrow{margin-top:16px}.metrics{margin:16px 0;gap:18px}.metrics strong{font-size:30px}.metrics small{font-size:9px}.section{padding-top:14px;margin-top:17px}.callout{font-size:10.5px;padding:10px 14px;margin:16px 0}table{margin:11px 0;line-height:1.6}th,td{padding:7px 4px}.diagnostics{margin:11px 0}.case{font-size:9.5px;line-height:1.65;padding:11px 0}.question{font-size:11px}.steps{font-size:10px;line-height:1.65}.steps li{margin:6px 0}.footer{margin-top:17px;padding-top:11px;font-size:8px}.muted{font-size:8.5px}.case .muted{margin:5px 0}.fingerprint{font-size:8px;line-height:1.6}}
  @media print{header{display:table;width:100%;table-layout:fixed}header strong,header small{display:table-cell;vertical-align:middle;line-height:1.4}header strong{width:25%}header small{text-align:right;margin:0}}
  .continuation{text-align:right;color:#71767a;font:9px/1.4 Consolas,monospace;padding-bottom:8px}
  @media print{.fingerprint{display:none}}
  </style></head><body>
  <article class="page"><header><strong>EvalPi</strong><small>RESEARCH NOTE / JUDGE VALIDATION</small></header>
  <p class="eyebrow">01 / MEASURING THE EVALUATOR</p><h1>打分器能否作出可信判定？</h1><p class="lede">固定评分器、独立参考标签、逐条原始证据。记录当前能力，也记录还不能得出的结论。</p>
  <div class="callout">本轮为${human ? '公开人工标签基准初验' : '构造证据契约检查'}。${run.status === 'completed' ? '计划批次已完成。' : '本批未完成，未执行项按原状保留。'} 这份报告不授予上线合格结论；构造案例与人工标注分别统计。</div>
  <div class="metrics"><div><strong>${heldout ? pct(heldout.primary.accuracy.rate) : '—'}</strong>保留集首轮标签匹配率<small>${heldout ? `${rate(heldout.primary.accuracy)} · 95% CI ${ci(heldout.primary.accuracy)}` : '本次未运行保留集'}</small></div><div><strong>${human?.caseCount ?? 0}</strong>独立人工标签案例<small>每 source 至多一条回复；英文 QA 资料忠实性</small></div><div><strong>${run.trials.length}/${run.planned}</strong>已记录 / 计划调用<small>每例 ${run.repeats} 次 · ${esc(model)}</small></div></div>
  <div class="section"><h2>三组结果，保留各自边界</h2><table><thead><tr><th>样本来源</th><th>独立 Case</th><th>首轮标签匹配</th><th>Wilson 95% 区间</th><th>重复一致</th></tr></thead><tbody>${rows}</tbody></table><p class="muted">主指标每例仅计第 1 轮；人工集的 pending、调用异常、未运行均计未匹配。构造集参考为 pending 时，同标签算匹配。重复一致率只纳入全部轮次成功返回的案例，分母见附录。</p></div>
  <div class="section"><h2>保留验收集 · 错在哪里</h2>${diagnostics(heldout)}${matrix(heldout)}<p class="muted">误报 = 参考 pass 被判 fail / 全部参考 pass；漏判 = 参考 fail 被判 pass / 全部参考 fail。待定与异常分开呈现，不隐藏在漏判统计中。平衡抽样不能估计线上问题发生率。</p></div>
  <p class="footer">运行 ${esc(run.id)} · ${esc(run.finishedAt ?? run.startedAt)}<br>本报告由保存的 Judge 原始结果生成；没有将待人工核查的分歧改写为新真值。</p></article>
  <article class="page"><div class="continuation">EVIDENCE / LIMITATIONS / NEXT CHECK</div>
  <p class="eyebrow">02 / EXAMINING DISAGREEMENTS</p><h2>留下可复核的分歧</h2><p class="lede">共有 ${review.length} 个案例进入复核候选清单，包含与参考不一致、调用异常、缺失轮次或重复判定变化。自动入列不等于人工确认 Judge 出错。</p>${caseBlocks || '<div class="callout">本轮没有发现与参考标签不一致的已执行案例。小样本相符仍需在新的真实任务上继续验证。</div>'}
  <div class="section"><h2>证据契约与待定处理</h2>${matrix(contract)}<p class="muted">${contract ? `${contract.caseCount} 条构造案例覆盖业务动作证据、知识材料、同一 Case 多轮上下文与输出评分指令注入。参考结论由显式契约推导，尚未独立人工复核，无法替代真实标注集。` : '本次未包含构造案例，不能从本报告判断证据不足处理能力。'}</p></div>
  <div class="section"><h2>这轮还不能回答的事</h2><ol class="steps">${human ? '<li>RAGTruth 是公开旧数据，模型是否见过这些内容无法排除；小样本区间较宽，不能据此承诺实际业务准确率。</li>' : ''}<li>当前范围为所选资料忠实性或工具证据契约案例。客服综合能力、中文业务标准及 Trace 归因仍需要新的真实人工标签。</li><li>本轮评分提示词未调优。${heldoutInvoked ? '保留集已有案例被本次验收读取；后续若参考这些分歧修改规则，应新增未查看过的验收集。' : '本次没有已保存的保留集判定；尚不能报告保留集验收成绩。'}</li></ol></div>
  <div class="footer"><div class="links"><a href="review-queue.json">完整复核清单</a><a href="trials.jsonl">逐次 Judge 理由</a><a href="results.csv">逐条对照表</a><a href="manifest.json">运行指纹</a><a href="cases.json">案例与原始参考</a></div>${human ? '<p>数据来源：<a href="https://github.com/ParticleMedia/RAGTruth">ParticleMedia / RAGTruth</a> · 固定 revision c103204b9ce28d6bbad859304bf30de72b8ed8fe。MIT 及底层数据来源说明随基准保留。</p>' : '<p>数据来源：EvalPi 构造证据契约探针；参考标签尚未独立人工复核。</p>'}<p class="fingerprint">Scorer ${esc(spec?.fingerprint ?? '未记录')}<br>Prompt SHA256 ${esc(spec?.promptSha256 ?? '未记录')}</p></div></article></body></html>`;
  await writeFile(path.join(directory, 'judge-report.html'), html, 'utf8');
  await writeFile(path.join(directory, 'review-queue.json'), JSON.stringify(review, null, 2), 'utf8');
  const byId = new Map(cases.map(item => [item.id, item]));
  const table = [['case_id', 'source', 'split', 'label_origin', 'reference', 'repeat', 'status', 'prediction', 'reason']];
  for (const row of run.trials) {
    const item = byId.get(row.caseId);
    table.push([row.caseId, item?.source, item?.split, item?.labelOrigin, item?.referenceVerdict, row.trial, row.status, row.verdict, row.reason]);
  }
  for (const item of cases) {
    for (let repeat = 1; repeat <= run.repeats; repeat++) {
      if (!run.trials.some(row => row.caseId === item.id && row.trial === repeat)) table.push([item.id, item.source, item.split, item.labelOrigin, item.referenceVerdict, repeat, 'not_run', '', '本轮未取得完整判定；结合 calls.jsonl 检查是否曾发起调用。']);
    }
  }
  await writeFile(path.join(directory, 'results.csv'), `\uFEFF${table.map(row => row.map(csv).join(',')).join('\r\n')}`, 'utf8');
  return { html: 'judge-report.html', reviews: review.length, csv: 'results.csv' };
}
