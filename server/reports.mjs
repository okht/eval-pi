import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cell = value => `"${String(value ?? '').replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""')}"`;
const verdicts = { pass: '通过', fail: '发现问题', pending: '证据不足', error: '执行或评分异常' };
const human = { issue: '人工确认有问题', clear: '人工判定无问题', recheck: '已交由 Agent 核查' };
const clip = (value, limit = 220) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};
const compactId = value => String(value).length > 18 ? `${String(value).slice(0, 12)}…${String(value).slice(-4)}` : String(value);
const countsOf = trials => trials.reduce((counts, trial) => {
  counts[trial.verdict in counts ? trial.verdict : 'pending']++;
  return counts;
}, { pass: 0, fail: 0, pending: 0, error: 0 });
const heading = (number, label, title) => `<div class="section-heading"><p class="eyebrow">${number} / ${label}</p><h2>${title}</h2></div>`;
const completedRetry = record => record.source === 'judge-retry' && (record.gradingStatus === 'completed' || (!record.gradingStatus && ['pass', 'fail', 'pending'].includes(record.verdict)));
const retryLabel = record => record.gradingStatus === 'error' ? '评分失败' : record.gradingStatus === 'cancelled' ? '评分已停止' : verdicts[record.verdict];

function stateSummary(state) {
  if (state === undefined) return '本次未取得由运行器采集的业务状态；完整执行证据见附录。';
  if (state === null || typeof state !== 'object') return clip(state === null ? 'null' : state);
  const items = [];
  for (const [key, value] of Object.entries(state)) {
    if (['sessionId', 'session_id'].includes(key)) continue;
    if (Array.isArray(value)) {
      const references = value.slice(0, 3).map(item => {
        if (item && typeof item === 'object') return [item.id, item.orderId].filter(v => v !== undefined).map(v => clip(v, 35)).join(' / ');
        return clip(item, 45);
      }).filter(Boolean);
      items.push(`${key}：${value.length} 条${references.length ? `（${references.join('；')}${value.length > 3 ? '；…' : ''}）` : ''}`);
    } else if (value && typeof value === 'object') {
      const scalars = Object.entries(value).filter(([, child]) => child === null || typeof child !== 'object').slice(0, 3);
      items.push(`${key}：${scalars.length ? scalars.map(([name, child]) => `${name}=${clip(child, 35)}`).join('，') : '结构化状态，详见附录'}`);
    } else items.push(`${key}：${clip(value, 70)}`);
    if (items.length >= 5) break;
  }
  return items.join('；') || '已采集状态对象，无可在正文摘要中展示的业务字段。';
}

function toolSummary(trace) {
  const results = trace.filter(item => item && typeof item === 'object' && (item.type === 'tool_result' || item.type === 'harness_error'));
  if (!results.length) return '<p class="evidence-value">Trace 未提供工具结果事件，无法据此确认工具执行情况。</p>';
  return `<ul class="tool-evidence">${results.slice(0, 3).map(item => {
    if (item.type === 'harness_error') return `<li><strong>执行异常</strong><span>${esc(clip(item.message ?? item.code, 170))}</span></li>`;
    const facts = [
      item.turn !== undefined ? `第 ${item.turn} 轮` : '',
      item.status !== undefined ? `状态 ${item.status}` : '',
      item.committed === true ? '已提交' : item.committed === false ? '未提交' : '',
      item.success === true ? '返回成功' : item.success === false ? '返回失败' : '',
      item.ticketId !== undefined ? `记录 ${item.ticketId}` : '',
    ].filter(Boolean);
    const resultText = typeof item.result === 'string' ? clip(item.result, 240) : '';
    const metadata = facts.join(' · ') || item.message || (resultText ? '' : '事件未提供状态字段');
    return `<li><strong>${esc(clip(item.name ?? '工具结果', 70))}</strong>${metadata ? `<span>${esc(clip(metadata, 200))}</span>` : ''}${resultText ? `<span>工具返回：${esc(resultText)}</span>` : ''}</li>`;
  }).join('')}${results.length > 3 ? `<li class="muted">另有 ${results.length - 3} 条结果事件，详见 Trace 附录。</li>` : ''}</ul>`;
}

function targetSummary(trials) {
  const fields = [['repository', '仓库', 160], ['commit', 'Commit', 64], ['sdkVersion', 'SDK', 40], ['provider', '供应商', 60], ['model', '被测模型', 80], ['businessEnvironment', '业务环境', 220]];
  const groups = new Map();
  let recorded = 0;
  for (const trial of trials) {
    const target = trial.output?.target;
    if (!target || typeof target !== 'object' || Array.isArray(target)) continue;
    const values = fields.map(([key]) => {
      const value = key === 'repository' ? target.repository ?? target.repo : target[key];
      return typeof value === 'string' ? value.trim() : '';
    });
    if (!values.some(Boolean)) continue;
    recorded++;
    const key = JSON.stringify(values);
    const group = groups.get(key) ?? { values, count: 0 };
    group.count++;
    groups.set(key, group);
  }
  if (!recorded) return '';
  const records = [...groups.values()];
  const coverage = `来源由被测项目适配器记录，覆盖 ${recorded}/${trials.length} 次执行。${groups.size > 1 ? `本批包含 ${groups.size} 组不同来源记录，各组分别列出。` : ''}${recorded < trials.length ? '其余执行未提供来源信息。' : ''}`;
  const rows = records.slice(0, 3).map(({ values, count }, index) => {
    const descriptions = values.flatMap((value, fieldIndex) => {
      if (!value) return [];
      const [key, label, limit] = fields[fieldIndex];
      const summary = key === 'businessEnvironment' && /\bupstream mock\b/i.test(value) ? `上游示例的模拟业务环境（${clip(value, limit)}）` : clip(value, limit);
      return [`${label}：${summary}`];
    });
    return `<p class="table-note">${groups.size > 1 ? `来源 ${index + 1} · ` : ''}${count} 次执行 · ${esc(descriptions.join('；'))}</p>`;
  }).join('');
  return `<div class="target-source"><p class="table-note"><strong>被测对象来源</strong> · ${esc(coverage)}</p>${rows}${records.length > 3 ? `<p class="table-note">另有 ${records.length - 3} 组来源，完整记录见附录。</p>` : ''}</div>`;
}

export async function createReport({ project, plan, run, directory, assetsRoot }) {
  if (!run || !plan) throw new Error('请先完成至少一次实际执行。');
  const isFixture = project.manifest?.kind === 'deterministic-fixture' || plan.source === 'fixture';
  const id = `${run.id}-${randomUUID().slice(0, 8)}`;
  const filename = `${id}-report.html`;
  await mkdir(directory, { recursive: true });
  const valid = run.trials.filter(t => t.verdict === 'pass' || t.verdict === 'fail');
  const passed = valid.filter(t => t.verdict === 'pass').length;
  const errors = run.trials.filter(t => t.status === 'error' || t.verdict === 'error' || t.grading?.status === 'error').length;
  const gradingCompleted = run.trials.filter(t => t.judgeSource === 'llm' && t.grading?.status === 'completed').length;
  const gradingFailed = run.trials.filter(t => t.grading?.status === 'error').length;
  const gradingCancelled = run.trials.filter(t => t.grading?.status === 'cancelled').length;
  const retryRecords = (run.rechecks ?? []).filter(record => record.source === 'judge-retry');
  const completedRetryIds = new Set(retryRecords.filter(completedRetry).map(record => record.trialId));
  const outstandingGrading = run.trials.filter(t => ['error', 'cancelled'].includes(t.grading?.status) && !completedRetryIds.has(t.id)).length;
  const hasGrading = Boolean(run.judge) || run.trials.some(t => t.judgeSource === 'llm') || plan.judge === 'llm';
  const pending = run.trials.filter(t => t.verdict === 'pending').length;
  const percent = valid.length ? `${(passed / valid.length * 100).toFixed(1)}%` : '—';
  const cases = new Map(plan.cases.map(item => [item.id, item]));
  const caseName = caseId => cases.get(caseId)?.name ?? caseId;
  const incomplete = run.status !== 'completed' || valid.length !== run.planned || outstandingGrading > 0;
  const rechecks = new Map((run.rechecks ?? []).filter(record => record.source !== 'judge-retry').map(record => [record.trialId, record]));
  const gradingRetries = new Map(retryRecords.map(record => [record.trialId, record]));
  const csvName = `${id}-results.csv`, traceName = `${id}-traces.jsonl`, snapshotName = `${id}-snapshot.json`;
  const rows = [
    ['case_id', 'trial', 'session_id', 'status', 'verdict', 'reason', 'execution_duration_ms', 'judge_source', 'rule_verdict', 'rule_reason', 'judge_provider', 'judge_model', 'grading_status', 'grading_verdict', 'grading_reason', 'grading_duration_ms', 'grading_error_code', 'human_review', 'recheck_verdict', 'recheck_reason', 'rechecked_at', 'retry_grading_status', 'retry_verdict', 'retry_reason', 'retry_model', 'retried_at'],
    ...run.trials.map(t => { const check = rechecks.get(t.id), retry = gradingRetries.get(t.id); return [t.caseId, t.trial, t.sessionId, t.status, t.verdict, t.reason, t.durationMs, t.judgeSource, t.ruleResult?.verdict ?? '', t.ruleResult?.reason ?? '', run.judge?.provider ?? '', run.judge?.model ?? '', t.grading?.status ?? '', t.grading?.verdict ?? '', t.grading?.reason ?? '', t.grading?.durationMs ?? '', t.grading?.errorCode ?? '', run.reviews[t.caseId] ?? '', check?.verdict ?? '', check?.reason ?? '', check?.checkedAt ?? '', retry?.gradingStatus ?? '', retry?.verdict ?? '', retry?.reason ?? '', retry?.judge?.model ?? '', retry?.checkedAt ?? '']; }),
  ];
  await writeFile(path.join(directory, csvName), '\ufeff' + rows.map(row => row.map(cell).join(',')).join('\r\n'));
  await writeFile(path.join(directory, traceName), run.trials.map(t => JSON.stringify({ ...t, rechecks: (run.rechecks ?? []).filter(record => record.trialId === t.id) })).join('\n') + '\n');
  await writeFile(path.join(directory, snapshotName), JSON.stringify({ id, project, plan, run }, null, 2), { mode: 0o600 });
  let brand = '';
  try { brand = `<img alt="EvalPi" src="data:image/svg+xml;base64,${(await readFile(path.join(assetsRoot, 'evalpi.svg'))).toString('base64')}"/>`; } catch { /* The wordmark remains readable without an icon. */ }

  const grouped = [...new Set([...plan.cases.map(item => item.id), ...run.trials.map(t => t.caseId)])].map(caseId => ({ caseId, trials: run.trials.filter(t => t.caseId === caseId) }));
  const evidence = grouped.flatMap(group => {
    const trial = group.trials.find(t => t.verdict === 'fail') ?? group.trials.find(t => t.verdict === 'error') ?? group.trials.find(t => t.verdict === 'pending');
    return trial ? [trial] : [];
  }).slice(0, 4);
  const hasLongIds = grouped.some(group => group.caseId.length > 18);
  const reviewSummary = ({ caseId, trials }) => {
    const records = trials.map(t => rechecks.get(t.id)).filter(Boolean);
    const labels = [];
    if (run.reviews[caseId]) labels.push(human[run.reviews[caseId]]);
    if (records.length) {
      const counts = countsOf(records);
      const values = [[counts.fail, '问题'], [counts.pass, '通过'], [counts.pending, '待定'], [counts.error, '异常']].filter(([count]) => count).map(([count, label]) => `${count} 次${label}`);
      labels.push(`自动：${values.join('、')}`);
    }
    const retryCount = trials.filter(t => completedRetryIds.has(t.id)).length;
    const gradingErrors = trials.filter(t => t.grading?.status === 'error' || t.grading?.status === 'cancelled').length;
    if (gradingErrors) labels.push(`原始评分未完成 ${gradingErrors} 次`);
    if (retryCount) labels.push(`重试补齐 ${retryCount} 次`);
    return labels.map(label => `<span>${esc(label)}</span>`).join('') || '<span class="muted">未人工判定</span>';
  };
  const renderCase = trial => {
    const record = rechecks.get(trial.id);
    const retry = gradingRetries.get(trial.id);
    const grading = run.judge || trial.judgeSource === 'llm' ? trial.grading : undefined;
    const expected = cases.get(trial.caseId)?.expected;
    const reply = trial.output?.reply ?? (Array.isArray(trial.output?.replies) ? trial.output.replies.at(-1) : undefined);
    return `<div class="case">
      <div class="case-title"><span class="case-code" title="${esc(trial.caseId)}">${esc(compactId(trial.caseId))}</span><h3>${esc(caseName(trial.caseId))}</h3></div>
      <p class="tag">代表执行：第 ${trial.trial} 次 · 原始判定：${esc(verdicts[trial.verdict])} · ${esc(human[run.reviews[trial.caseId]] ?? '未人工判定')}</p>
      ${expected ? `<p class="case-expectation"><span>预期</span>${esc(clip(expected, 200))}</p>` : ''}
      <p class="case-finding">${esc(clip(trial.reason || trial.error || '暂无判定说明。', 320))}</p>
      ${trial.ruleResult || grading ? `<p class="grading-detail">${trial.ruleResult ? `业务规则：${esc(verdicts[trial.ruleResult.verdict])}。` : ''}${grading ? `原始模型评分：${grading.status === 'completed' ? esc(verdicts[grading.verdict] ?? '已完成') : grading.status === 'error' ? '失败' : grading.status === 'cancelled' ? '已停止' : '未调用'}${grading.durationMs !== undefined ? `（${(grading.durationMs / 1000).toFixed(1)} 秒）` : ''}。` : ''}${trial.ruleResult?.verdict === 'fail' ? '规则失败结论保留。' : ''}</p>` : ''}
      <dl class="evidence-list"><div><dt>实际回复</dt><dd>${reply !== undefined ? esc(clip(typeof reply === 'string' ? reply : '目标返回结构化回复，详见附录。', 250)) : '目标未提供可读取的回复文本。'}</dd></div><div><dt>业务状态</dt><dd>${esc(stateSummary(trial.output?.observedState))}</dd></div><div><dt>工具证据</dt><dd>${toolSummary(Array.isArray(trial.trace) ? trial.trace : [])}</dd></div></dl>
      ${record ? `<p class="recheck"><strong>最近自动核查 · ${esc(verdicts[record.verdict])}</strong><span>${esc(clip(record.reason, 230))}</span></p>` : ''}
      ${retry ? `<p class="recheck"><strong>最近评分重试 · ${esc(retryLabel(retry))}${retry.judge?.model ? ` · ${esc(retry.judge.model)}` : ''}</strong><span>${esc(clip(retry.reason, 160))}</span></p>` : ''}
      <p class="evidence-reference">逐次索引 ${esc(trial.id)} · 完整回复、状态与 Trace 见附录。</p>
    </div>`;
  };

  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(project.name)} · 实测报告</title><style>
    *{box-sizing:border-box}body{margin:0;background:#f3f2f0;color:#252f3d;font:14px/1.8 'Microsoft YaHei','Segoe UI',sans-serif}article{max-width:880px;margin:auto;padding:48px 58px}header{display:flex;align-items:center;gap:12px;border-bottom:1px solid #c9c8c5;padding-bottom:22px}header img{width:26px;height:26px}header strong{font:27px Georgia,serif}header small{margin-left:auto;color:#6c737b;font-size:11px}h1{font:37px/1.45 Georgia,'Noto Serif SC',SimSun,serif;margin:34px 0 14px}h1 span{display:block;font-size:27px;margin-top:8px}h2{font:23px/1.5 Georgia,SimSun,serif;margin:7px 0 16px}h3{font-size:15px;line-height:1.7;margin:0;font-weight:600}.eyebrow{font:10px/1.6 Consolas,monospace;letter-spacing:1.1px;color:#844f3b;margin:0}.report-date{font:10px/1.7 Consolas,monospace;color:#88909a;margin:14px 0 0}section{margin-top:32px;border-top:1px solid #ccc;padding-top:22px}.section-heading{break-inside:avoid;page-break-inside:avoid;break-after:avoid;page-break-after:avoid}.summary{border-left:3px solid #4b607c;padding:12px 18px;background:#e9ecee;font-size:12px;line-height:1.85}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;padding:24px 0 17px}.metrics strong{display:block;font:34px/1.5 Georgia,serif;color:#4b607c}.metrics>div{font-size:12px}.metrics small{font-size:10px}.muted,small{color:#687078}.report-scope{font-size:11px;line-height:1.8;margin:8px 0 0}.case{padding:20px 0 18px;border-top:1px solid #d7d5d1;break-inside:avoid;page-break-inside:avoid}.case:first-of-type{border-top:0}.case-title{display:flex;align-items:baseline;gap:12px;break-after:avoid}.case-code{font:11px/1.6 Consolas,monospace;color:#844f3b;white-space:nowrap;flex-shrink:0}.tag{font-size:10px;color:#844f3b;margin:8px 0 13px}.case-expectation{font-size:11px;color:#7b858c;margin:0 0 10px}.case-expectation>span{margin-right:9px;color:#8e979c}.grading-summary{font-size:10px;line-height:1.8;color:#687987;margin:6px 0 8px}.grading-summary strong{color:#4b607c;font-weight:500}.grading-detail{font-size:10px;line-height:1.75;color:#788690;margin:0 0 12px}.case-finding{font-size:12px;margin:0 0 15px;color:#33475a;font-weight:500}.evidence-list{margin:0;padding:0 14px;background:#e9e8e5;border-radius:2px}.evidence-list>div{display:grid;grid-template-columns:62px minmax(0,1fr);gap:12px;padding:11px 0;border-bottom:1px solid #d9dbd9;break-inside:avoid}.evidence-list>div:last-child{border-bottom:0}.evidence-list dt{color:#758088;font-size:10px}.evidence-list dd{margin:0;font-size:11px;line-height:1.75;overflow-wrap:anywhere}.tool-evidence{list-style:none;margin:0;padding:0}.tool-evidence li{display:flex;flex-direction:column;gap:2px;margin-bottom:6px}.tool-evidence li:last-child{margin-bottom:0}.tool-evidence strong{font:10px/1.6 Consolas,monospace;overflow-wrap:anywhere;color:#50687b}.tool-evidence span{font-size:10px}.evidence-value{margin:0;font-size:11px}.recheck{padding:10px 0 0;margin:9px 0 0;font-size:11px}.recheck strong{display:block;font-size:10px;color:#4b607c;margin-bottom:4px}.evidence-reference{font:9px/1.7 Consolas,'Microsoft YaHei',monospace;color:#8b9199;margin:12px 0 0;overflow-wrap:anywhere}.case-table{border-collapse:collapse;width:100%;table-layout:fixed;font-size:10px;line-height:1.7}.case-table th,.case-table td{border-bottom:1px solid #d7d5d1;text-align:left;padding:10px 6px;vertical-align:top}.case-table th{font-size:10px;font-weight:500;color:#6b7784;white-space:nowrap}.case-table th.num,.case-table td.num{text-align:center;font-variant-numeric:tabular-nums;white-space:nowrap}.case-table .table-id{font:10px/1.7 Consolas,monospace;white-space:nowrap}.case-table td.review span{display:block;overflow-wrap:break-word;margin-bottom:3px}.table-note{font-size:10px;color:#828b94;margin:12px 0 0}.methods{font-size:12px}.methods ul{padding-left:18px;margin:0 0 16px}.methods li{margin:7px 0;padding-left:3px;break-inside:avoid}.method-note{padding:13px 17px;background:#e9ecee;border-left:2px solid #4b607c;font-size:11px}.methods p{line-height:1.85}.appendices a{display:flex;align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid #dddcd8;text-decoration:none;font-size:12px;break-inside:avoid}.appendices a span{font:10px Consolas,monospace;color:#8b9198}.appendices p{font-size:10px;margin-top:12px}a{color:#4b607c;text-underline-offset:4px}footer{margin-top:30px;border-top:1px solid #ccc;padding-top:14px;font-size:9px;line-height:1.8;color:#8b9198;overflow-wrap:anywhere}p{overflow-wrap:anywhere;orphans:3;widows:3}.goal{font-size:12px;line-height:1.85;margin:0;color:#78818b;max-width:640px}
    @media(max-width:620px){article{padding:28px 22px}h1{font-size:29px}h1 span{font-size:23px}.metrics{gap:10px}.metrics strong{font-size:27px}.metrics>div{font-size:10px}.case-title{gap:9px}.case-title h3{font-size:13px}.evidence-list{padding:0 10px}.evidence-list>div{grid-template-columns:48px minmax(0,1fr);gap:9px}.case-table th,.case-table td{padding:8px 3px}.case-table th,.case-table .table-id{font-size:9px}}
    @media print{body{background:white;font-size:12px;line-height:1.75}article{padding:0;max-width:none}header{padding-bottom:17px}header strong{font-size:25px}h1{font-size:32px;margin-top:27px}h1 span{font-size:24px}h2{font-size:21px}section{margin-top:25px;padding-top:18px;break-inside:auto}.evidence-section{break-before:page;page-break-before:always;margin-top:0;border-top:0;padding-top:0}.section-heading{break-after:avoid;page-break-after:avoid;break-inside:avoid;page-break-inside:avoid}.section-heading+.case,.section-heading+.summary,.section-heading+table,.section-heading+ul{break-before:avoid;page-break-before:avoid}.case{padding:16px 0}.case-title,h3{break-after:avoid;page-break-after:avoid}.case-table thead{display:table-header-group}.case-table tr{break-inside:avoid;page-break-inside:avoid}.case-table th,.case-table td{padding:8px 6px}.metrics,.summary,.method-note{break-inside:avoid;page-break-inside:avoid}.metrics{padding:20px 0 12px}.metrics strong{font-size:31px}.methods,.appendices{break-inside:avoid;page-break-inside:avoid}a{color:inherit}@page{size:A4;margin:17mm 16mm}}
  </style></head><body><article><header>${brand}<strong>EvalPi</strong><small>实际执行记录 · ${isFixture ? '本地测试项目' : '用户项目'}</small></header>
    <h1>${esc(project.name)}<span>基线评测报告</span></h1><p class="goal">${esc(plan.goal)}</p><p class="report-date">${esc(new Date().toISOString())}</p>
    <section>${heading('01', '本轮结果', incomplete ? '本批含未完成执行或原始判定缺口' : passed === valid.length ? '本批有效执行均通过当前标准' : '已发现需要核查的问题')}<div class="summary">计划 ${plan.cases.length} 个独立 Case，每个重复 ${plan.repeats} 次；已记录 ${run.trials.length}/${run.planned} 次执行，原始有效判定 ${valid.length} 次。${incomplete ? '本页通过率依据原始判定；重试与核查结果另行记录，需结合其覆盖情况确认批次结论。' : '以下结论对应本批测试覆盖的场景。'}</div>
      <div class="metrics"><div>原始有效判定通过率<strong>${percent}</strong><small>${passed}/${valid.length} 次原始有效判定</small></div><div>执行或评分异常<strong>${errors}</strong><small>异常执行去重计数，含模型评分失败</small></div><div>证据不足<strong>${pending}</strong><small>保留为待定</small></div></div>${hasGrading ? `<div class="grading-summary"><strong>本轮评分模型：${run.judge ? `${esc(run.judge.model)} · ${esc(run.judge.provider)}` : '旧记录未保存模型标识'}</strong><br>原始模型评分已完成 ${gradingCompleted} 次，失败 ${gradingFailed} 次，停止 ${gradingCancelled} 次；重试 ${retryRecords.length} 次，已补齐 ${completedRetryIds.size} 次。${outstandingGrading ? `仍有 ${outstandingGrading} 次评分未完成。` : ''}${!run.trials.some(t => t.grading) ? '旧记录未保存逐次模型评分状态，完成次数暂无法核验。' : ''}</div>` : ''}<p class="report-scope muted">原始评分、人工判断与自动核查分别记录。本轮尚未执行调优、回归或盲测；费用因缺少真实计费记录暂不统计。</p>
    </section>
    <section>${heading('02', '案例概览', '按能力场景查看结果')}<table class="case-table"><colgroup><col style="width:15%"><col style="width:9%"><col style="width:9%"><col style="width:9%"><col style="width:9%"><col style="width:9%"><col style="width:40%"></colgroup><thead><tr><th>Case</th><th class="num">重复</th><th class="num">通过</th><th class="num">失败</th><th class="num">待定</th><th class="num">异常</th><th>人工 / 自动核查</th></tr></thead><tbody>${grouped.map(group => { const counts = countsOf(group.trials); return `<tr><td><span class="table-id" title="${esc(group.caseId)}">${esc(compactId(group.caseId))}</span></td><td class="num">${group.trials.length}/${plan.repeats}</td><td class="num">${counts.pass}</td><td class="num">${counts.fail}</td><td class="num">${counts.pending}</td><td class="num">${counts.error}</td><td class="review">${reviewSummary(group)}</td></tr>`; }).join('')}</tbody></table><p class="table-note">重复列为已记录 / 计划次数；判定数量采用原始执行记录。逐次详情、耗时与核查理由见 CSV。${hasLongIds ? '过长的 Case 编号在正文缩写，完整编号见附录。' : ''}</p></section>
    <section class="evidence-section">${heading('03', '代表案例', '问题与关键证据')}${evidence.length ? `<p class="table-note">选取 ${evidence.length} 个存在问题、异常或证据缺口的案例，各展示一次代表执行；其余重复与完整 Trace 收录于附录。</p>${evidence.map(renderCase).join('')}` : '<p class="muted">当前记录中没有失败、异常或待定项。完整逐次结果已保存在附录，仍需结合测试集覆盖范围判断适用边界。</p>'}</section>
    <section class="methods">${heading('04', '方法与范围', '按照确认的标准，保留原始证据')}<ul>${plan.criteria.map(criterion => `<li>${esc(criterion)}</li>`).join('')}</ul><p>判定方式：${hasGrading ? '分别保存业务规则与 LLM Judge 结果，每次模型评分使用独立上下文；规则失败会保留为业务失败。评分重试仅使用已保存证据，不重复执行被测项目。' : '依据项目提供的明确业务状态规则检查，本批未调用模型评分。'}每次执行使用独立进程与临时工作目录，按适配协议采集业务状态；项目自行访问的外部数据库、共享账号和网络服务需另行隔离，当前环境未提供操作系统级沙箱。</p>${targetSummary(run.trials)}${isFixture ? '<div class="method-note">本轮被测对象为内置的确定性客服测试程序，实际启动进程并读写测试业务状态。这些结果用于验证评测链路，不能代表真实大模型质量。</div>' : ''}<p class="table-note">运行状态：${esc(run.status)}。本报告及附录保存生成时的方案、执行与复核快照，后续操作不会改写这些文件。</p></section>
    <section class="appendices">${heading('05', '附录索引', '完整结果与执行记录')}<a href="./${csvName}">逐次结果与最新核查<span>CSV ↗</span></a><a href="./${traceName}">完整输出、Trace 与核查记录<span>JSONL ↗</span></a><a href="./${snapshotName}">项目、方案与本轮结果快照<span>JSON ↗</span></a><p class="muted">离线阅读时，将附录与报告保存在同一目录。正文中的摘录用于快速核查，完整内容以附录为准。</p></section>
    <footer>EvalPi · 报告快照 ${esc(id)}<br>计划 ${esc(plan.id)} · 运行 ${esc(run.id)}</footer>
  </article></body></html>`;
  await writeFile(path.join(directory, filename), html, 'utf8');
  return { filename, url: `/api/files/${filename}` };
}
