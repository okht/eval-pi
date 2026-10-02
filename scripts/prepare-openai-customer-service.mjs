import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

const commit = '58b08f846c28ef070118f628c4fb0e84d52ca110';
const repository = 'https://github.com/openai/openai-agents-js';
const base = `https://raw.githubusercontent.com/openai/openai-agents-js/${commit}`;
const directory = new URL('../examples/openai-customer-service/upstream/', import.meta.url);
async function readSource(path) {
  const response = await fetch(`${base}/${path}`, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Upstream download failed: ${response.status}`);
  return response.text();
}
const [original, license] = await Promise.all([
  readSource('examples/customer-service/index.ts'), readSource('LICENSE'),
]);
const marker = '// Main function';
if (original.split(marker).length !== 2) throw new Error('Pinned source layout has changed');
// Keep upstream Agent, tool, prompt and handoff definitions exactly; replace only the CLI host.
const definitions = original.slice(0, original.indexOf(marker));
const generated = stripTypeScriptTypes(`${definitions}\nexport { faqAgent, seatBookingAgent, triageAgent };\n`, { mode: 'strip' });
const hash = (text) => createHash('sha256').update(text).digest('hex');
await mkdir(directory, { recursive: true });
await writeFile(new URL('index.ts.txt', directory), original);
await writeFile(new URL('agents.mjs', directory), generated);
await writeFile(new URL('LICENSE', directory), license);
await writeFile(new URL('provenance.json', directory), JSON.stringify({
  repository, commit, sourcePath: 'examples/customer-service/index.ts', sdkVersion: '0.18.0',
  originalSha256: hash(original), generatedSha256: hash(generated),
  adaptation: 'Original Agent/tool/prompt/handoff definitions retained; upstream interactive CLI replaced by EvalPi JSON I/O. Model transport uses the Pi adapter. No business logic patch.',
  businessEnvironment: 'Upstream mock FAQ and seat-update context; no real airline service.',
}, null, 2));
console.log(`Prepared pinned source ${commit} in ${fileURLToPath(directory)}`);
