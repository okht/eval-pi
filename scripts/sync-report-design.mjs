import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = fileURLToPath(new URL('../', import.meta.url));
const sourceArg = process.argv.slice(2).find(arg => !arg.startsWith('--'));
if (!sourceArg) throw new Error('Usage: node scripts/sync-report-design.mjs <local-design-system-checkout> [--check]');
const source = path.resolve(sourceArg);
const check = process.argv.includes('--check');
const theme = JSON.parse(await readFile(path.join(source, 'reports/theme.json'), 'utf8'));
if (theme.scope !== 'visual-only' || !Array.isArray(theme.webFonts)) throw new Error('Unsupported report design manifest.');
const entries = ['theme.json', 'theme.css', 'report.css'].map(file => [`reports/${file}`, `src/design-system/reports/${file}`]);
const fonts = new Set([...theme.webFonts.map(face => face.file), ...Object.values(theme.pdfFonts).flatMap(font => font.files.map(face => face.file)), 'NotoSerifSC-OFL.txt']);
for (const file of fonts) {
  if (file !== path.basename(file)) throw new Error(`Invalid font filename: ${file}`);
  entries.push([`assets/fonts/report/${file}`, `public/fonts/${file}`]);
}
entries.push(['assets/fonts/report/SOURCES.md', 'public/fonts/REPORT-SOURCES.md']);
const hashes = {};
for (const [from, to] of entries) {
  const data = await readFile(path.join(source, from));
  hashes[from] = createHash('sha256').update(data).digest('hex');
  const destination = path.join(app, to);
  if (check) {
    if (!(await readFile(destination)).equals(data)) throw new Error(`Design resource differs: ${to}`);
  } else {
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, data);
  }
}
if (check) {
  const lock = JSON.parse(await readFile(path.join(app, 'src/design-system/source.json'), 'utf8'));
  if (lock.themeVersion !== theme.version || JSON.stringify(lock.files) !== JSON.stringify(hashes)) throw new Error('Design provenance hashes are stale; sync the resources again.');
} else {
  const revision = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  await writeFile(path.join(app, 'src/design-system/source.json'), JSON.stringify({ repository: 'https://github.com/okht/eval-pi-design-system', revision, themeVersion: theme.version, files: hashes }, null, 2) + '\n');
}
console.log(check ? 'Report styles, manifest and font assets match the design system.' : 'Synced report design into local application assets.');
