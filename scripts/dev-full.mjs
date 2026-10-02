import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const children = [
  spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, EVALPI_DEV: '1' }, stdio: 'inherit', windowsHide: true }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { cwd: root, stdio: 'inherit', windowsHide: true }),
];
let stopped = false;
function stop(code = 0) { if (stopped) return; stopped = true; for (const child of children) child.kill(); process.exitCode = code; }
children.forEach(child => { child.on('error', error => { console.error(error.message); stop(1); }); child.on('exit', code => stop(code ?? 0)); });
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
