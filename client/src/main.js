const { app, BrowserWindow, session, ipcMain, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const DEFAULT_URL = 'https://chatgpt.com/';
let mainWindow;
let environments = [];

const configPath = () => path.join(app.getPath('userData'), 'environments.json');
const clone = (value) => JSON.parse(JSON.stringify(value));

function normalizeUrl(value) {
  const url = new URL(value || DEFAULT_URL);
  if (url.protocol !== 'https:') throw new Error('站点地址必须使用 HTTPS。');
  return url.toString();
}

function normalizeProxy(value) {
  if (!value) return '';
  const proxy = new URL(value);
  if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(proxy.protocol) || !proxy.hostname || !proxy.port) {
    throw new Error('代理必须为带端口的 http、https、socks4 或 socks5 地址。');
  }
  if (proxy.username || proxy.password || (proxy.pathname && proxy.pathname !== '/') || proxy.search || proxy.hash) {
    throw new Error('代理地址不能包含账号、路径、参数或片段。');
  }
  // Chromium proxyRules 不接受 URL 序列化后附加的根路径 “/”。
  return `${proxy.protocol}//${proxy.host}`;
}

function sanitizeInput(input, current = {}) {
  const name = String(input.name || '').trim();
  if (!name || name.length > 80) throw new Error('环境名称必须为 1–80 个字符。');
  return {
    ...current,
    name,
    provider: input.provider === 'custom' ? 'custom' : 'chatgpt',
    baseUrl: normalizeUrl(input.baseUrl),
    proxy: normalizeProxy(String(input.proxy || '').trim()),
    locale: String(input.locale || 'zh-CN').trim().slice(0, 32) || 'zh-CN',
    timezone: String(input.timezone || 'Asia/Shanghai').trim().slice(0, 64) || 'Asia/Shanghai',
    updatedAt: new Date().toISOString(),
  };
}

async function loadEnvironments() {
  try {
    const raw = await fs.readFile(configPath(), 'utf8');
    const data = JSON.parse(raw);
    environments = Array.isArray(data) ? data : [];
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('读取环境配置失败:', error);
    environments = [];
  }
}

async function persistEnvironments() {
  const file = configPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, JSON.stringify(environments, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(`${file}.tmp`, file);
}

function findEnvironment(id) {
  const env = environments.find((item) => item.id === id);
  if (!env) throw new Error('环境不存在。');
  return env;
}

function configureSession(ses) {
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
}

async function openEnvironment(id) {
  const env = findEnvironment(id);
  const ses = session.fromPartition(env.partition);
  configureSession(ses);
  const proxyRules = env.proxy ? normalizeProxy(env.proxy) : '';
  await ses.setProxy(proxyRules ? { proxyRules } : { mode: 'system' });

  const win = new BrowserWindow({
    width: env.windowBounds?.width || 1280,
    height: env.windowBounds?.height || 900,
    minWidth: 720,
    minHeight: 520,
    title: `GPT Set · ${env.name}`,
    webPreferences: {
      partition: env.partition,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('close', () => {
    const bounds = win.getBounds();
    const existing = environments.find((item) => item.id === env.id);
    if (existing) {
      existing.windowBounds = { width: bounds.width, height: bounds.height };
      persistEnvironments().catch(console.error);
    }
  });
  env.lastOpenedAt = new Date().toISOString();
  await persistEnvironments();
  await win.loadURL(env.baseUrl);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 850,
    minHeight: 600,
    title: 'GPT Set',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

ipcMain.handle('environments:list', () => clone(environments));
ipcMain.handle('environments:create', async (_event, input) => {
  const now = new Date().toISOString();
  const id = randomUUID();
  const env = sanitizeInput(input, {
    id, partition: `persist:gpt-env-${id}`, createdAt: now, archived: false,
  });
  environments.unshift(env);
  await persistEnvironments();
  return clone(env);
});
ipcMain.handle('environments:update', async (_event, id, input) => {
  const env = findEnvironment(id);
  Object.assign(env, sanitizeInput(input, env));
  await persistEnvironments();
  return clone(env);
});
ipcMain.handle('environments:copy', async (_event, id) => {
  const source = findEnvironment(id);
  const now = new Date().toISOString();
  const newId = randomUUID();
  const copy = {
    ...source, id: newId, name: `${source.name} 副本`, partition: `persist:gpt-env-${newId}`,
    createdAt: now, updatedAt: now, lastOpenedAt: undefined, windowBounds: undefined,
  };
  environments.unshift(copy);
  await persistEnvironments();
  return clone(copy);
});
ipcMain.handle('environments:setArchived', async (_event, id, archived) => {
  const env = findEnvironment(id);
  env.archived = Boolean(archived);
  env.updatedAt = new Date().toISOString();
  await persistEnvironments();
});
ipcMain.handle('environments:open', (_event, id) => openEnvironment(id));
ipcMain.handle('environments:wipe', async (_event, id) => {
  const env = findEnvironment(id);
  const ses = session.fromPartition(env.partition);
  await ses.clearStorageData({ storages: ['cookies', 'filesystem', 'indexdb', 'localstorage', 'serviceworkers', 'cache_storage', 'websql'] });
  await ses.clearCache();
});
ipcMain.handle('environments:delete', async (_event, id) => {
  const env = findEnvironment(id);
  const ses = session.fromPartition(env.partition);
  await ses.clearStorageData();
  await ses.clearCache();
  environments = environments.filter((item) => item.id !== env.id);
  await persistEnvironments();
});
ipcMain.handle('environments:import', async () => {
  const { canceled, filePaths } = await require('electron').dialog.showOpenDialog(mainWindow, {
    title: '导入环境配置', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePaths[0]) return 0;
  const parsed = JSON.parse(await fs.readFile(filePaths[0], 'utf8'));
  if (!Array.isArray(parsed.environments)) throw new Error('无效的环境配置文件。');
  const now = new Date().toISOString();
  const imported = parsed.environments.map((item) => {
    const id = randomUUID();
    return sanitizeInput(item, { id, partition: 'persist:gpt-env-' + id, createdAt: now, archived: false });
  });
  environments.unshift(...imported);
  await persistEnvironments();
  return imported.length;
});
ipcMain.handle('environments:export', async () => {
  const { canceled, filePath } = await require('electron').dialog.showSaveDialog(mainWindow, {
    title: '导出环境配置', defaultPath: 'gpt-set-environments.json', filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return false;
  const safe = environments.map(({ partition, ...env }) => env);
  await fs.writeFile(filePath, JSON.stringify({ version: 1, environments: safe }, null, 2), 'utf8');
  return true;
});

app.whenReady().then(async () => {
  await loadEnvironments();
  createMainWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });





