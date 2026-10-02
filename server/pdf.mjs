import { spawn } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export async function renderReportPdf({ appRoot, directory, filename }) {
  const pdfName = filename.replace(/\.html$/, '.pdf');
  const electron = process.versions.electron ? process.execPath : require('electron');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => {
    const child = spawn(electron, [path.join(appRoot, 'desktop', 'render-pdf.mjs'), path.join(directory, filename), path.join(directory, pdfName)], { env, shell: false, windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('PDF 排版超时，HTML 报告和附录已保留。')); }, 30000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('PDF 排版进程无法启动，HTML 报告和附录已保留。')); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('PDF 排版失败，HTML 报告和附录已保留。')); });
  });
  return `/api/files/${pdfName}`;
}
