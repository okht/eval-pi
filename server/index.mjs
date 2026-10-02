import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRuntime } from './runtime.mjs';
import { startServer } from './http.mjs';
import { renderReportPdf } from './pdf.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.EVALPI_DATA_DIR ?? path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'EvalPi', 'workspace');
const runtime = await createRuntime({ appRoot, dataDir, pdfRenderer: renderReportPdf });
const service = await startServer({ runtime, dataDir, appRoot, port: Number(process.env.EVALPI_PORT ?? 4317), allowedOrigins: process.env.EVALPI_DEV === '1' ? ['http://127.0.0.1:5173'] : [] });
console.log(`EvalPi ready: ${service.url}`);
process.parentPort?.postMessage({ type: 'ready', url: service.url });
let closing = false;
async function close() {
  if (closing) return; closing = true;
  await runtime.dispose(); await service.close(); process.exit(0);
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
process.parentPort?.on('message', event => { if (event.data?.type === 'shutdown') void close(); });
