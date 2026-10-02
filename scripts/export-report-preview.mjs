import { createServer } from 'vite';
import React from 'react';
import { renderToFile } from '@react-pdf/renderer';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const directory = path.resolve('output/pdf');
const snapshotId = 'r003-pi-preview';
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  await mkdir(directory, { recursive: true });
  const { ReportPdfDocument, registerReportFonts } = await server.ssrLoadModule('/src/components/ReportPdf.tsx');
  const { buildReportHtml } = await server.ssrLoadModule('/src/components/ReportView.tsx');
  const { reportFontFaces } = await server.ssrLoadModule('/src/lib/reportFonts.ts');
  const { buildCaseCsv, buildTraceJsonl } = await server.ssrLoadModule('/src/lib/demoData.ts');
  registerReportFonts(path.resolve('public/fonts').replaceAll('\\', '/'));
  const fonts = (await Promise.all(reportFontFaces.map(async face => {
    const data = await readFile(path.join('public', face.path));
    return `@font-face{font-family:'${face.family}';font-style:${face.style};font-weight:${face.weight};font-display:swap;src:url(data:font/${face.format};base64,${data.toString('base64')}) format('${face.format}');}`;
  }))).join('\n');
  await renderToFile(React.createElement(ReportPdfDocument, { completed: true, snapshotId }), path.join(directory, 'EvalPi_售后客服Agent_评测报告.pdf'));
  await writeFile(path.join(directory, 'EvalPi_售后客服Agent_评测报告.html'), buildReportHtml(true, null, snapshotId, fonts));
  await writeFile(path.join(directory, `EvalPi_${snapshotId}_case_results.csv`), buildCaseCsv(true));
  await writeFile(path.join(directory, `EvalPi_${snapshotId}_traces.jsonl`), buildTraceJsonl(true));
  console.log('Exported PDF, offline HTML, CSV and Trace to output/pdf');
} finally { await server.close(); }
