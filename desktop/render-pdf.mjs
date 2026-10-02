import { app, BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
const [source, destination] = process.argv.slice(2);
if (!source || !destination || !path.isAbsolute(source) || !path.isAbsolute(destination)) process.exit(2);
app.commandLine.appendSwitch('disable-gpu');
void app.whenReady().then(async () => {
const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false } });
window.webContents.session.webRequest.onBeforeRequest((details, done) => done({ cancel: !['file:', 'data:', 'devtools:'].some(scheme => details.url.startsWith(scheme)) }));
window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
try {
  await window.loadFile(source);
  const pdf = await window.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: '<div style="font-size:8px;color:#777;width:100%;text-align:center;font-family:Arial"><span class="pageNumber"></span> / <span class="totalPages"></span></div>' });
  await writeFile(destination, pdf);
  app.exit(0);
} catch { app.exit(1); }
});
