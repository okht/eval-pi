import { useState } from 'react';
import ReportView from './ReportView';
import { buildCaseCsv, buildTraceJsonl, downloadTextFile } from '../lib/demoData';

const SNAPSHOT = 'r003-pi-preview';

export default function ReportPreviewPage() {
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  async function savePdf(event: React.MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setStatus('正在排版 PDF…');
    try {
      const { createReportPdf } = await import('./ReportPdf');
      const blob = await createReportPdf(true, null, SNAPSHOT);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = 'EvalPi_售后客服Agent_评测报告.pdf'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus('PDF 已生成并开始下载');
    } catch { setStatus('文件生成未完成，请重试。'); }
    finally { setBusy(false); }
  }
  return <main className="eval-report-standalone">
    <nav aria-label="报告文件" className="eval-report-preview-nav">
      <a href="/">← EvalPi</a>
      <span>REPORT / 003</span>
      <a href="#pdf" onClick={savePdf} aria-disabled={busy}>{busy ? '正在排版…' : '评测报告.pdf ↗'}</a>
      <span role="status">{status}</span>
    </nav>
    <ReportView completed snapshotId={SNAPSHOT} onAppendix={kind => downloadTextFile(
      `EvalPi_${SNAPSHOT}_${kind === 'cases' ? 'case_results.csv' : 'traces.jsonl'}`,
      kind === 'cases' ? buildCaseCsv(true) : buildTraceJsonl(true),
      kind === 'cases' ? 'text/csv;charset=utf-8' : 'application/x-ndjson;charset=utf-8',
    )} />
  </main>;
}
