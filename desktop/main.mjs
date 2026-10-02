import { app, BrowserWindow, dialog, ipcMain, shell, utilityProcess } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
app.setName('EvalPi');
let backend, window, serviceUrl, closing = false;
const single = app.requestSingleInstanceLock();
if (!single) app.quit();
else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus(); });
  void app.whenReady().then(async () => {
  backend = utilityProcess.fork(path.join(appRoot, 'server', 'index.mjs'), [], {
    cwd: appRoot, serviceName: 'EvalPi runtime', stdio: 'pipe',
    env: { ...process.env, EVALPI_PORT: '0', EVALPI_DATA_DIR: process.env.EVALPI_DATA_DIR ?? path.join(app.getPath('userData'), 'workspace') },
  });
  backend.stderr?.on('data', chunk => process.stderr.write(chunk));
  backend.stdout?.on('data', chunk => process.stdout.write(chunk));
  backend.on('exit', code => { if (!closing && code !== 0) dialog.showErrorBox('后台运行异常', 'EvalPi 后台已退出。完成的评测记录已保存，请重新启动应用。'); });
  const readyTimeout = setTimeout(() => { dialog.showErrorBox('启动超时', '后台未能就绪，请查看终端错误后重试。'); app.quit(); }, 30000);
  backend.on('message', async message => {
    if (message.type !== 'ready' || serviceUrl) return;
    clearTimeout(readyTimeout); serviceUrl = message.url;
    window = new BrowserWindow({ width: 1380, height: 920, minWidth: 780, minHeight: 650, title: 'EvalPi', backgroundColor: '#fcfbf8', autoHideMenuBar: true, show: false,
      webPreferences: { preload: path.join(appRoot, 'desktop', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
    });
    const origin = new URL(serviceUrl).origin;
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.setWindowOpenHandler(({ url }) => {
      const target = new URL(url);
      if (target.origin === origin && target.pathname.startsWith('/api/files/')) {
        const report = new BrowserWindow({ width: 1040, height: 860, title: 'EvalPi · 报告', autoHideMenuBar: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false } });
        report.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        report.webContents.on('will-navigate', (event, next) => { if (new URL(next).origin !== origin) event.preventDefault(); });
        void report.loadURL(url);
      }
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== origin) event.preventDefault(); });
    window.webContents.on('did-fail-load', (_event, code, description) => console.error(`EvalPi page load failed: ${code} ${description}`));
    await window.loadURL(serviceUrl);
    window.show();
    console.log('EvalPi desktop window ready');
  });
  const validate = event => {
    if (!window || event.sender !== window.webContents || !serviceUrl || new URL(event.senderFrame.url).origin !== new URL(serviceUrl).origin || event.senderFrame !== window.webContents.mainFrame) throw new Error('拒绝未知页面的桌面请求。');
  };
  ipcMain.handle('evalpi:choose-folder', async event => { validate(event); const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'], title: '选择待评测项目' }); return result.canceled ? null : result.filePaths[0]; });
  ipcMain.handle('evalpi:open-external', async (event, value) => {
    validate(event);
    if (typeof value !== 'string' || value.length > 16000) throw new Error('登录地址无效。');
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname) || url.username || url.password) throw new Error('仅允许打开所选服务的官方登录页面。');
    await shell.openExternal(url.href);
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (closing) return;
    closing = true; event.preventDefault();
    backend?.postMessage({ type: 'shutdown' });
    const deadline = setTimeout(() => { backend?.kill(); app.exit(); }, 5000);
    backend?.once('exit', () => { clearTimeout(deadline); app.exit(); });
  });
  });
}
