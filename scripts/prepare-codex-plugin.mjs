import { access, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = '.evalpi-plugin-package.json';
const SCHEMA_VERSION = 1;
const SOURCE_FILES = ['plugin.json', 'skills/evaluate/SKILL.md'];

function within(parent, child) {
  const path = relative(parent, child);
  return path !== '' && !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
}

async function assertNoLinks(root, destination) {
  let path = root;
  for (const part of relative(root, destination).split(sep).filter(Boolean)) {
    path = join(path, part);
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error(`Refusing a linked package path: ${path}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export function defaultPluginDataDir() {
  const root = process.platform === 'win32' ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
    : process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support')
      : process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(root, 'EvalPi', 'plugin');
}

/** Prepare a machine-local catalog. Does not install, authenticate, or modify Codex settings. */
export async function prepareCodexPlugin({
  appRoot = APP_ROOT,
  outputDir,
  dataDir = defaultPluginDataDir(),
  modelsDir,
  check = false,
} = {}) {
  const engineRoot = await realpath(resolve(appRoot));
  const outputRoot = join(engineRoot, 'output');
  const destination = resolve(outputDir || join(outputRoot, 'codex-plugin'));
  if (!within(outputRoot, destination)) throw new Error('Plugin output must be a subdirectory of the EvalPi checkout output/ directory.');
  await assertNoLinks(engineRoot, destination);
  await assertNoLinks(engineRoot, join(destination, MARKER));

  const entry = join(engineRoot, 'server', 'mcp.mjs');
  await access(entry);
  // Resolve with ESM import conditions from the actual engine checkout. Pi is import-only.
  const dependencies = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { access } from 'node:fs/promises';
    import { fileURLToPath } from 'node:url';
    for (const name of ['@modelcontextprotocol/sdk/server/mcp.js', '@earendil-works/pi-coding-agent', 'promptfoo']) {
      try { await access(fileURLToPath(import.meta.resolve(name))); }
      catch { console.error(name); process.exit(1); }
    }
  `], { cwd: engineRoot, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (dependencies.error || dependencies.status !== 0) {
    throw new Error(`Cannot resolve engine dependencies${dependencies.stderr?.trim() ? ` (${dependencies.stderr.trim().slice(0, 300)})` : ''}. Run npm ci in the EvalPi checkout first.`);
  }
  const engineDataDir = resolve(dataDir);
  const modelDataDir = resolve(modelsDir || join(engineDataDir, 'models'));
  const server = {
    type: 'stdio',
    command: process.execPath,
    args: [entry],
    env: { EVALPI_PLUGIN_DATA_DIR: engineDataDir, EVALPI_MODEL_DATA_DIR: modelDataDir },
  };
  const pluginDir = join(destination, 'plugins', 'evalpi');
  const marketplacePath = join(destination, '.agents', 'plugins', 'marketplace.json');
  const expectedMarker = { schemaVersion: SCHEMA_VERSION, engineRoot };
  let existingMarker;
  try { existingMarker = await readJson(join(destination, MARKER)); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`Invalid package marker: ${error.message}`); }
  if (existingMarker) {
    if (existingMarker.schemaVersion !== SCHEMA_VERSION || existingMarker.engineRoot !== engineRoot) {
      throw new Error('The output belongs to a different engine or package format. Choose a fresh output directory.');
    }
  } else {
    let entries = [];
    try { entries = await readdir(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (entries.length) throw new Error('Refusing to overwrite a nonempty directory that was not prepared by EvalPi.');
    if (check) throw new Error('No prepared plugin package found. Run the preparation command first.');
  }

  const sourceDir = join(engineRoot, 'plugins', 'evalpi');
  const sourceFiles = await Promise.all(SOURCE_FILES.map(async path => [path, await readFile(join(sourceDir, path), 'utf8')]));
  const manifest = JSON.parse(sourceFiles.find(([path]) => path === 'plugin.json')[1]);
  const marketplace = {
    name: 'evalpi-local',
    interface: { displayName: 'EvalPi Local' },
    plugins: [{ name: 'evalpi', source: { source: 'local', path: './plugins/evalpi' }, policy: { installation: 'AVAILABLE', authentication: 'ON_USE' }, category: 'Developer Tools' }],
  };
  const mcp = { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: { evalpi: server } };
  const { type: _type, ...legacyServer } = server;
  const compatibility = {
    name: manifest.name, version: manifest.version, description: manifest.description,
    skills: './skills/', mcpServers: './.mcp.json',
    interface: manifest.extensions['com.openai'].interface,
  };
  const generated = [
    ...sourceFiles.map(([path, contents]) => [join(pluginDir, path), contents]),
    [join(pluginDir, 'mcp.json'), `${JSON.stringify(mcp, null, 2)}\n`],
    [join(pluginDir, '.mcp.json'), `${JSON.stringify({ mcpServers: { evalpi: legacyServer } }, null, 2)}\n`],
    [join(pluginDir, '.codex-plugin', 'plugin.json'), `${JSON.stringify(compatibility, null, 2)}\n`],
    [marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`],
  ];

  for (const [path] of generated) await assertNoLinks(engineRoot, path);
  if (check) {
    for (const [path, expected] of generated) {
      if (await readFile(path, 'utf8') !== expected) throw new Error(`Prepared package is out of date: ${path}. Run preparation again with the same options.`);
    }
  } else {
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, MARKER), `${JSON.stringify(expectedMarker, null, 2)}\n`);
    for (const [path, contents] of generated) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents);
    }
  }
  return { ready: true, checked: check, marketplaceRoot: destination, marketplacePath, pluginDir, nodePath: process.execPath, enginePath: entry, dataDir: engineDataDir, modelsDir: modelDataDir };
}

export function parseArguments(args) {
  const options = {};
  const names = { '--output': 'outputDir', '--data-dir': 'dataDir', '--models-dir': 'modelsDir' };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--check') options.check = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (names[argument]) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}.`);
      options[names[argument]] = value;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log('Usage: node scripts/prepare-codex-plugin.mjs [--output <path inside output/>] [--data-dir <private state directory>] [--models-dir <EvalPi model directory>] [--check]\n\nPrepares a local Codex marketplace using absolute engine and Node paths. Does not install or enable the plugin.');
    } else {
      console.log(JSON.stringify(await prepareCodexPlugin(options), null, 2));
    }
  } catch (error) {
    console.error(`EvalPi plugin preparation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
