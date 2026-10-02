import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJudgeBenchmarkReport } from '../server/judge-benchmark-report.mjs';
import { computeJudgeMetrics } from '../server/judge-benchmark.mjs';
import { renderReportPdf } from '../server/pdf.mjs';

const [input, destination, format] = process.argv.slice(2);
if (!input || !destination || (format && format !== '--pdf')) throw new Error('Usage: node scripts/report-judge-benchmark.mjs <run-directory> <report-directory> [--pdf]');
const directory = path.resolve(destination);
const runDirectory = path.resolve(input);
await mkdir(directory, { recursive: true });
const [run, cases, manifest] = await Promise.all(['run.json', 'cases.json', 'manifest.json'].map(async name => JSON.parse(await readFile(path.join(runDirectory, name), 'utf8'))));
// A hard exit may leave the mutable snapshot behind append-only evidence.
run.trials = (await readFile(path.join(runDirectory, 'trials.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
run.summary = computeJudgeMetrics(cases, run.trials, { repeats: run.repeats });
const result = await createJudgeBenchmarkReport({ run, cases, manifest, directory });
for (const filename of ['cases.json', 'manifest.json', 'calls.jsonl', 'trials.jsonl', 'run.json']) {
  if (directory !== runDirectory) await copyFile(path.join(runDirectory, filename), path.join(directory, filename));
}
await writeFile(path.join(directory, 'summary.json'), JSON.stringify(run.summary, null, 2), 'utf8');
if (cases.some(item => item.source === 'ragtruth-qa')) {
  await copyFile(fileURLToPath(new URL('../benchmarks/judge/LICENSE.RAGTruth', import.meta.url)), path.join(directory, 'LICENSE.RAGTruth'));
}
if (format === '--pdf') {
  await renderReportPdf({ appRoot: fileURLToPath(new URL('../', import.meta.url)), directory, filename: result.html });
}
console.log(JSON.stringify({ ...result, directory, pdf: format === '--pdf' ? 'judge-report.pdf' : null }));
