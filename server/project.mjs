import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_TARGET_TIMEOUT_MS, MIN_TARGET_TIMEOUT_MS, MAX_TARGET_TIMEOUT_MS } from './limits.mjs';

const MAX_FILES = 200;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_SOURCE_CHARS = 16_000;
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage', 'output', 'tmp', 'vendor', '__pycache__']);
const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.json', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.yaml', '.yml']);
const SECRET_FILE = /(?:^\.env(?:\.|$)|credential|secret|api[-_]?key|auth\.json|token\.json|\.pem$|\.key$)/i;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function resolveProjectFile(projectPath, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath) || relativePath.includes('\0')) {
    throw new Error('项目文件必须是项目内的相对路径。');
  }
  const root = await realpath(projectPath);
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('项目入口不能越过所选项目目录。');
  }
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error('项目入口及其目录不能使用符号链接。');
  }
  const info = await lstat(resolved);
  if (!info.isFile()) throw new Error('项目入口必须是普通文件。');
  if (await realpath(resolved) !== resolved) throw new Error('项目文件的真实路径与所选路径不一致。');
  return resolved;
}

function validateCase(entry, seen) {
  if (!object(entry) || typeof entry.id !== 'string' || !/^[\w-]{1,64}$/.test(entry.id) || seen.has(entry.id)) {
    throw new Error('每个测试用例需要唯一 id（字母、数字、下划线或短横线，最多 64 字符）。');
  }
  seen.add(entry.id);
  if (typeof entry.name !== 'string' || !entry.name.trim() || !object(entry.input) || typeof entry.expected !== 'string' || !entry.expected.trim()) {
    throw new Error(`用例 ${entry.id} 缺少 name、input 或 expected。`);
  }
  if (JSON.stringify(entry.input).length > 16_000) throw new Error(`用例 ${entry.id} 输入过大。`);
  if (entry.checks !== undefined) {
    if (!Array.isArray(entry.checks) || entry.checks.length > 20) throw new Error(`用例 ${entry.id} checks 最多 20 条。`);
    for (const check of entry.checks) {
      if (!object(check) || typeof check.path !== 'string' || !check.path || check.path.split('.').some((key) => FORBIDDEN_KEYS.has(key)) || !['equals', 'includes', 'exists'].includes(check.op)) {
        throw new Error(`用例 ${entry.id} 包含不支持的检查规则。`);
      }
    }
  }
}

function validateManifest(manifest) {
  if (!object(manifest) || manifest.version !== 1 || typeof manifest.entry !== 'string' || !/\.(?:mjs|cjs|js)$/i.test(manifest.entry)) {
    throw new Error('evalpi.json 需要 version: 1 和指向 JavaScript 文件的 entry。');
  }
  if (!Array.isArray(manifest.cases) || manifest.cases.length < 1 || manifest.cases.length > 50) throw new Error('evalpi.json 需要 1–50 条明确测试用例。');
  const seen = new Set();
  manifest.cases.forEach((entry) => validateCase(entry, seen));
  if (manifest.stateFile !== undefined && (typeof manifest.stateFile !== 'string' || !/^[\w-]+\.json$/.test(manifest.stateFile))) {
    throw new Error('stateFile 仅支持试验工作目录内的单个 JSON 文件名。');
  }
  if (manifest.criteria !== undefined && (!Array.isArray(manifest.criteria) || manifest.criteria.length > 20 || manifest.criteria.some((value) => typeof value !== 'string'))) {
    throw new Error('criteria 必须是最多 20 条文字标准。');
  }
  for (const [key, fallback, min, max] of [['repeats', 3, 1, 10], ['timeoutMs', DEFAULT_TARGET_TIMEOUT_MS, MIN_TARGET_TIMEOUT_MS, MAX_TARGET_TIMEOUT_MS]]) {
    const value = manifest[key] ?? fallback;
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} 必须是 ${min}–${max} 之间的整数。`);
  }
  return manifest;
}

export async function inspectProject(projectPath) {
  if (typeof projectPath !== 'string' || !projectPath.trim()) throw new Error('请选择本地项目文件夹。');
  const selected = path.resolve(projectPath);
  const selectedInfo = await lstat(selected);
  if (!selectedInfo.isDirectory() || selectedInfo.isSymbolicLink()) throw new Error('项目需要是普通目录，不能使用符号链接。');
  const root = await realpath(selected);
  const files = [];
  let truncated = false;
  let scannedEntries = 0;
  async function visit(directory, depth = 0) {
    if (depth > 5) { truncated = true; return; }
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of children) {
      if (files.length >= MAX_FILES || scannedEntries >= 2000) { truncated = true; return; }
      scannedEntries++;
      if (entry.name.startsWith('.') || SECRET_FILE.test(entry.name) || entry.isSymbolicLink()) continue;
      const full = path.join(directory, entry.name);
      const info = await lstat(full);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) await visit(full, depth + 1);
      } else if (info.isFile() && info.size <= MAX_FILE_BYTES && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  }
  await visit(root);
  let manifest;
  try {
    const manifestPath = await resolveProjectFile(root, 'evalpi.json');
    const info = await lstat(manifestPath);
    if (info.size > MAX_FILE_BYTES) throw new Error('evalpi.json 超过 128 KiB。');
    manifest = validateManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
    await resolveProjectFile(root, manifest.entry);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (manifest) throw new Error('evalpi.json 指定的入口文件不存在。');
  }
  const excerpts = [];
  let remaining = MAX_SOURCE_CHARS;
  const samples = [...files].sort((a, b) => Number(/^(README|evalpi|package)/i.test(b)) - Number(/^(README|evalpi|package)/i.test(a))).slice(0, 8);
  for (const file of samples) {
    if (remaining <= 0) break;
    const absolute = await resolveProjectFile(root, file);
    const content = (await readFile(absolute, 'utf8')).slice(0, Math.min(2400, remaining));
    if (content.includes('\0')) continue;
    remaining -= content.length;
    excerpts.push(`文件 ${file}\n${content}`);
  }
  return {
    path: root,
    name: typeof manifest?.name === 'string' ? manifest.name.slice(0, 120) : path.basename(root),
    files,
    summary: `只读检查了 ${files.length} 个文本文件${truncated ? '（目录过深或数量达到上限，已截断）' : ''}。${manifest ? '发现明确的 evalpi.json 测试协议。' : '尚无 evalpi.json；可先讨论评测目标与适配协议。'}\n\n${excerpts.join('\n\n')}`,
    runnable: Boolean(manifest),
    ...(manifest ? { manifest } : {}),
  };
}

export function createFixturePlan(project) {
  if (!project?.manifest) throw new Error('项目尚未提供 evalpi.json 测试协议。');
  const manifest = validateManifest(project.manifest);
  return {
    id: `plan-${randomUUID()}`,
    title: `${project.name} · 基线评测`,
    goal: typeof manifest.goal === 'string' ? manifest.goal : '核验任务结果、后台状态与回复是否一致。',
    criteria: manifest.criteria ?? ['以执行证据与实际业务状态核验预期结果。', '每条用例和每次重复使用独立进程与工作目录。'],
    cases: manifest.cases.map(({ id, name, input, expected }) => ({ id, name, input: structuredClone(input), expected })),
    repeats: manifest.repeats ?? 3,
    timeoutMs: manifest.timeoutMs ?? DEFAULT_TARGET_TIMEOUT_MS,
    judge: 'rules',
    entry: manifest.entry,
    confirmed: false,
    source: manifest.kind === 'deterministic-fixture' ? 'fixture' : 'agent',
    createdAt: new Date().toISOString(),
  };
}
