import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parseArguments, prepareCodexPlugin } from '../scripts/prepare-codex-plugin.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = join(appRoot, 'output');

async function temporaryDirectory(t) {
  await mkdir(outputRoot, { recursive: true });
  const path = await mkdtemp(join(outputRoot, 'plugin-package-test-'));
  t.after(async () => {
    const root = await realpath(outputRoot);
    const actual = await realpath(path);
    const child = relative(root, actual);
    assert.ok(child && !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
    await rm(actual, { recursive: true, force: true });
  });
  return path;
}

test('prepared package starts from a copied cache with spaces and Chinese characters', async t => {
  const temp = await temporaryDirectory(t);
  const options = { outputDir: join(temp, '准备 包'), dataDir: join(temp, 'private-data'), modelsDir: join(temp, 'explicit-models') };
  const result = await prepareCodexPlugin(options);
  assert.equal(result.modelsDir, options.modelsDir);
  const copy = join(temp, 'copied cache 插件');
  await cp(result.pluginDir, copy, { recursive: true });
  const config = JSON.parse(await readFile(join(copy, 'mcp.json'), 'utf8')).mcpServers.evalpi;
  assert.equal(config.command, process.execPath);
  assert.equal(config.args[0], join(await realpath(appRoot), 'server', 'mcp.mjs'));
  assert.ok(isAbsolute(config.command) && isAbsolute(config.args[0]));
  assert.equal(config.env.EVALPI_MODEL_DATA_DIR, options.modelsDir);
  const legacy = JSON.parse(await readFile(join(copy, '.mcp.json'), 'utf8')).mcpServers.evalpi;
  assert.deepEqual(legacy.args, config.args);
  const client = new Client({ name: 'evalpi-cache-package-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: config.command, args: config.args, env: config.env, cwd: copy, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', data => { stderr += data.toString(); });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some(tool => tool.name === 'evalpi_open'), stderr);
    assert.ok(tools.tools.some(tool => tool.name === 'evalpi_report'), stderr);
  } finally { await client.close(); }
});

test('preparation is repeatable, checks freshness, and keeps unrelated artifacts', async t => {
  const temp = await temporaryDirectory(t);
  const options = { outputDir: join(temp, 'prepared'), dataDir: join(temp, 'data') };
  const first = await prepareCodexPlugin(options);
  const sentinel = join(first.marketplaceRoot, 'keep.txt');
  await writeFile(sentinel, 'keep');
  await prepareCodexPlugin(options);
  assert.equal(await readFile(sentinel, 'utf8'), 'keep');
  assert.equal((await prepareCodexPlugin({ ...options, check: true })).checked, true);
  await writeFile(join(first.pluginDir, 'mcp.json'), '{}');
  await assert.rejects(prepareCodexPlugin({ ...options, check: true }), /out of date/);
  await prepareCodexPlugin(options);
  await prepareCodexPlugin({ ...options, check: true });
});

test('preparation refuses unrelated nonempty destinations and paths outside output', async t => {
  const temp = await temporaryDirectory(t);
  const destination = join(temp, 'unrelated');
  await mkdir(destination);
  await writeFile(join(destination, 'existing.txt'), 'preserve');
  await assert.rejects(prepareCodexPlugin({ outputDir: destination }), /nonempty directory/);
  assert.equal(await readFile(join(destination, 'existing.txt'), 'utf8'), 'preserve');
  await assert.rejects(prepareCodexPlugin({ outputDir: appRoot }), /subdirectory/);
  await assert.rejects(prepareCodexPlugin({ outputDir: outputRoot }), /subdirectory/);
});

test('CLI options reject incomplete or unknown arguments', () => {
  assert.deepEqual(parseArguments(['--data-dir', 'private state', '--models-dir', 'model root', '--check']), { dataDir: 'private state', modelsDir: 'model root', check: true });
  assert.throws(() => parseArguments(['--models-dir']), /Missing value/);
  assert.throws(() => parseArguments(['--unknown']), /Unknown argument/);
});

test('preparation refuses a linked output directory', async t => {
  const temp = await temporaryDirectory(t);
  const target = join(temp, 'real-directory');
  const link = join(temp, 'linked-directory');
  await mkdir(target);
  await writeFile(join(target, 'existing.txt'), 'preserve');
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareCodexPlugin({ outputDir: link }), /linked package path/);
  assert.equal(await readFile(join(target, 'existing.txt'), 'utf8'), 'preserve');
});
