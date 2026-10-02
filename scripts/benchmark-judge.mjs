import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModels, judgeSpecification } from '../server/models.mjs';
import { runJudgeBenchmark } from '../server/judge-benchmark.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const options = { run: false, split: 'all', repeats: 2, concurrency: 2 };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  if (flag === '--run') options.run = true;
  else if (['--split', '--output', '--data-dir', '--repeats', '--concurrency'].includes(flag)) {
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    options[flag.slice(2)] = ['--repeats', '--concurrency'].includes(flag) ? Number(value) : value;
  } else throw new Error(`Unknown option: ${flag}`);
}
if (!['all', 'development', 'heldout', 'contract'].includes(options.split)) throw new Error('Invalid split');
if (!Number.isInteger(options.repeats) || options.repeats < 1 || options.repeats > 5) throw new Error('repeats must be 1-5');
if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 4) throw new Error('concurrency must be 1-4');
const datasets = await Promise.all(['ragtruth-qa.json', 'contract-probes.json'].map(async name => {
  const value = JSON.parse(await readFile(path.join(root, 'benchmarks', 'judge', name), 'utf8'));
  return Array.isArray(value) ? value : value.cases;
}));
const cases = datasets.flat().filter(item => options.split === 'all' || item.split === options.split);
if (!cases.length) throw new Error('No cases selected');
const specification = judgeSpecification();
const plan = {
  cases: cases.length, repeats: options.repeats, plannedCalls: cases.length * options.repeats,
  concurrency: options.concurrency, split: options.split, scorerFingerprint: specification.fingerprint,
  groups: Object.fromEntries([...new Set(cases.map(item => `${item.source}/${item.split}`))].map(group => [group, cases.filter(item => `${item.source}/${item.split}` === group).length])),
};
console.log(JSON.stringify({ mode: options.run ? 'live' : 'dry-run', ...plan }));
if (!options.run) {
  console.log('Dry run only. Add --run to invoke the configured Judge. Labels are withheld from Judge requests.');
  process.exit(0);
}
if (!options['data-dir'] && !process.env.APPDATA) throw new Error('Specify --data-dir with the EvalPi workspace directory');
const workspace = path.resolve(options['data-dir'] ?? path.join(process.env.APPDATA, 'EvalPi', 'workspace'));
const directory = path.resolve(options.output ?? path.join(root, 'output', 'judge-benchmark', new Date().toISOString().replace(/[:.]/g, '-')));
const models = await createModels({ dataDir: path.join(workspace, 'models') });
const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  const status = await models.status();
  if (!status.authenticated) throw new Error('Connect a model in EvalPi before running the benchmark');
  const judgeInfo = { provider: status.provider, model: status.model, authMode: status.authMode, specification, timeoutMs: 60000 };
  console.log(JSON.stringify({ model: status.model, provider: status.provider, directory }));
  const run = await runJudgeBenchmark({ cases, directory, judge: models.judge, judgeInfo,
    repeats: options.repeats, concurrency: options.concurrency, signal: controller.signal,
    onProgress: ({ phase, completed }) => {
      if (phase !== 'completed') return;
      if (completed % 10 === 0 || completed === plan.plannedCalls) console.log(JSON.stringify({ completed, planned: plan.plannedCalls }));
    },
  });
  console.log(JSON.stringify({ status: run.status, planned: run.planned, completed: run.trials.length, directory }));
  if (run.status !== 'completed' || run.trials.some(item => item.status !== 'completed')) process.exitCode = 2;
} catch (error) {
  // Model errors are sanitized by the shared model boundary; do not print SDK response objects.
  console.error(error.message);
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  await models.dispose();
}
