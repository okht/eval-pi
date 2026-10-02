import type { ReviewSubmission } from '../components/ReviewPanel';

export type DemoRun = { case_id: string; dataset: 'regression-v1' | 'holdout-v1'; version: 'baseline' | 'candidate'; trial: number; passed: boolean; cost_cny: number; duration_ms: number; source: 'synthetic_frontend_demo' };

function failureIndices(total: number, count: number, mandatory: number[], excluded: number[]) {
  const failures = new Set(mandatory);
  for (let index = 0; failures.size < count; index++) {
    const position = (index * 37) % total;
    if (!excluded.includes(position)) failures.add(position);
  }
  return failures;
}

export function getDemoRuns(completed: boolean): DemoRun[] {
  const output: DemoRun[] = [];
  const goodSample = [186, 187, 188];
  const baselineFailures = failureIndices(360, 84, [40, 79, 94, 121, 166], goodSample);
  const candidateFailures = failureIndices(360, 30, [79, 94], [...goodSample, 39, 40, 41]);
  for (const version of completed ? ['baseline', 'candidate'] as const : ['baseline'] as const) {
    for (let index = 0; index < 360; index++) {
      output.push({ case_id: `CS-${String(Math.floor(index / 3) + 1).padStart(3, '0')}`, dataset: 'regression-v1', version, trial: index % 3 + 1, passed: !(version === 'baseline' ? baselineFailures : candidateFailures).has(index), cost_cny: version === 'baseline' ? 0.12 : 0.14, duration_ms: version === 'baseline' ? 3800 : 4200, source: 'synthetic_frontend_demo' });
    }
  }
  if (completed) {
    for (const version of ['baseline', 'candidate'] as const) {
      const failures = failureIndices(180, version === 'baseline' ? 45 : 18, [], []);
      for (let index = 0; index < 180; index++) output.push({ case_id: `BL-${String(Math.floor(index / 3) + 1).padStart(3, '0')}`, dataset: 'holdout-v1', version, trial: index % 3 + 1, passed: !failures.has(index), cost_cny: version === 'baseline' ? 0.12 : 0.14, duration_ms: version === 'baseline' ? 3800 : 4200, source: 'synthetic_frontend_demo' });
    }
  }
  return output;
}

function baselineReview(caseId: string, review: ReviewSubmission | null | undefined) {
  return review?.decisions[caseId] ?? (review?.uncheckedIds.includes(caseId) ? 'pending_agent_review' : 'not_reviewed');
}

export function buildCaseCsv(completed: boolean, review?: ReviewSubmission | null): string {
  const header = 'case_id,dataset,version,trial,automatic_passed,cost_cny,duration_ms,source,baseline_case_review';
  return '\uFEFF' + [header, ...getDemoRuns(completed).map(run => [run.case_id, run.dataset, run.version, run.trial, run.passed, run.cost_cny.toFixed(2), run.duration_ms, run.source, baselineReview(run.case_id, review)].join(','))].join('\r\n');
}

export function buildTraceJsonl(completed: boolean, review?: ReviewSubmission | null): string {
  return getDemoRuns(completed).map(run => {
    const special = run.case_id === 'CS-014' && run.version === 'baseline' && run.trial === 2;
    return JSON.stringify({ ...run, baseline_case_review: baselineReview(run.case_id, review), isolated_session: `${run.dataset}/${run.version}/${run.case_id}/${run.trial}`, trace: [
      { event: 'fixture_reset', state: 'case_initial_state', memory: 'empty' },
      { event: 'tool_result', tool: special ? 'create_after_sale' : 'demo_business_operation', status: run.passed ? 'success' : special ? 'timeout' : 'business_rule_mismatch' },
      { event: 'backend_check', record: run.passed ? `DEMO-${run.case_id}-${run.trial}` : null },
      { event: 'assistant_reply', text: special ? '已为您提交申请' : run.passed ? '已核验处理结果，并说明下一步。' : '示例回复与预期业务状态不一致。' },
      { event: 'judge', rubric_version: '1.2', verdict: run.passed ? 'pass' : 'candidate_issue', source: 'synthetic_frontend_demo' },
    ] });
  }).join('\n');
}

export function downloadTextFile(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
