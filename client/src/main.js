const { app, BrowserWindow, session, ipcMain, shell, dialog } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { McpManager, stripBom } = require('./mcp-manager');

const DEFAULT_URL = 'https://chatgpt.com/';
const USER_DATA_DIRECTORY = 'gpt-set-client';
app.setPath('userData', path.join(app.getPath('appData'), USER_DATA_DIRECTORY));
const PROJECT_ROOT = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..', '..');
const MCP_EXTENSION_SOURCE = path.join(PROJECT_ROOT, 'chatgpt-image-bridge-extension');
const hasSingleInstanceLock = app.requestSingleInstanceLock();

let mainWindow;
let environments = [];
let environmentsConfigError = null;
let mcpManager;
let environmentWriteQueue = Promise.resolve();
const activeEnvironmentSessions = new Set();
const extensionSignatures = new Map();
const extensionInstallPromises = new Map();
const environmentWindows = new Map();
let extensionSourceSignaturePromise = null;

const clone = (value) => JSON.parse(JSON.stringify(value));
const configPath = () => path.join(app.getPath('userData'), 'environments.json');
const extensionRoot = () => path.join(app.getPath('userData'), 'extensions');
const portableExecutableDirectory = () => path.resolve(
  String(process.env.PORTABLE_EXECUTABLE_DIR || '').trim() || path.dirname(process.execPath),
);
const manualExtensionDirectory = () => app.isPackaged
  ? path.join(portableExecutableDirectory(), 'chatgpt-image-bridge-extension')
  : MCP_EXTENSION_SOURCE;

async function atomicWriteJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.copyFile(file, `${file}.bak`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    await fs.rename(temporary, file);
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
    await fs.rm(file, { force: true });
    await fs.rename(temporary, file);
  }
}

function normalizeLoadedEnvironments(data) {
  if (!Array.isArray(data)) throw new Error('环境配置根节点必须是数组。');
  const ids = new Set();
  return data.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('环境配置包含无效项目。');
    const id = String(item.id || '').trim();
    const partition = String(item.partition || '').trim();
    if (!id || ids.has(id) || !partition.startsWith('persist:gpt-env-')) throw new Error('环境 ID 或 partition 无效。');
    ids.add(id);
    return { ...item, id, partition };
  });
}

async function loadEnvironments() {
  environmentsConfigError = null;
  const file = configPath();
  try {
    environments = normalizeLoadedEnvironments(JSON.parse(stripBom(await fs.readFile(file, 'utf8'))));
    return;
  } catch (error) {
    if (error.code === 'ENOENT') {
      environments = [];
      return;
    }
    console.error('读取环境配置失败，尝试备份:', error);
  }

  try {
    environments = normalizeLoadedEnvironments(JSON.parse(stripBom(await fs.readFile(`${file}.bak`, 'utf8'))));
    await fs.rename(file, `${file}.corrupt-${Date.now()}`).catch(() => {});
    await atomicWriteJson(file, environments);
  } catch (backupError) {
    environments = [];
    environmentsConfigError = new Error(`环境配置和备份都已损坏，原文件未被覆盖：${backupError.message}`);
  }
}

async function persistEnvironments() {
  if (environmentsConfigError) throw environmentsConfigError;
  const snapshot = clone(environments);
  const task = environmentWriteQueue.then(() => atomicWriteJson(configPath(), snapshot));
  environmentWriteQueue = task.catch(() => {});
  await task;
}

function assertEnvironmentConfig() {
  if (environmentsConfigError) throw environmentsConfigError;
}

function findEnvironment(id) {
  assertEnvironmentConfig();
  const environment = environments.find((item) => item.id === id);
  if (!environment) throw new Error('环境不存在。');
  return environment;
}

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
  return `${proxy.protocol}//${proxy.host}`;
}

function defaultMcpInstanceId() {
  return mcpManager?.defaultInstance()?.id || '';
}

function normalizeMcpInstanceId(value) {
  const id = String(value || '').trim();
  if (!id) return defaultMcpInstanceId();
  mcpManager.find(id);
  return id;
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
    imageBridgeEnabled: input.imageBridgeEnabled === true || input.imageBridgeEnabled === 'on',
    mcpInstanceId: normalizeMcpInstanceId(
      Object.prototype.hasOwnProperty.call(input, 'mcpInstanceId') ? input.mcpInstanceId : current.mcpInstanceId,
    ),
    updatedAt: new Date().toISOString(),
  };
}

function chromiumUserAgent() {
  const version = process.versions.chrome || '138.0.0.0';
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}

function configureSession(browserSession) {
  browserSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(['clipboard-sanitized-write', 'fullscreen', 'payment-handler'].includes(permission));
  });
  browserSession.setPermissionCheckHandler((_webContents, permission) => ['clipboard-sanitized-write', 'fullscreen', 'payment-handler'].includes(permission));
}

function bridgeConfigForEnvironment(environment) {
  let instance;
  try { instance = mcpManager.find(environment.mcpInstanceId || defaultMcpInstanceId()); } catch { instance = mcpManager.defaultInstance(); }
  if (!instance) return { endpoint: 'http://127.0.0.1:8787/bridge/capture', token: '', enabled: false, managed: true };
  return {
    endpoint: `http://127.0.0.1:${instance.port}/bridge/capture`,
    token: instance.token,
    enabled: environment.imageBridgeEnabled !== false,
    managed: true,
  };
}

async function extensionSourceSignature() {
  if (extensionSourceSignaturePromise) return extensionSourceSignaturePromise;
  extensionSourceSignaturePromise = (async () => {
    const hash = createHash('sha256');
    const visit = async (directory, relativeDirectory = '') => {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const relativePath = path.join(relativeDirectory, entry.name);
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(fullPath, relativePath);
        } else if (entry.isFile()) {
          hash.update(relativePath.replaceAll('\\', '/'));
          hash.update('\0');
          hash.update(await fs.readFile(fullPath));
          hash.update('\0');
        }
      }
    };
    await visit(MCP_EXTENSION_SOURCE);
    return hash.digest('hex');
  })().catch((error) => {
    extensionSourceSignaturePromise = null;
    throw error;
  });
  return extensionSourceSignaturePromise;
}

async function syncExtensionSource(destination) {
  const sourceSignature = await extensionSourceSignature();
  const signatureFile = `${destination}.source-signature`;
  const [installedSignature, manifestAvailable] = await Promise.all([
    fs.readFile(signatureFile, 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error)),
    fs.access(path.join(destination, 'manifest.json')).then(() => true, () => false),
  ]);
  if (manifestAvailable && installedSignature === sourceSignature) return;
  await fs.cp(MCP_EXTENSION_SOURCE, destination, { recursive: true, force: true });
  await fs.writeFile(signatureFile, sourceSignature, 'utf8');
}

async function ensureManualExtensionDirectory() {
  const destination = manualExtensionDirectory();
  if (destination === MCP_EXTENSION_SOURCE) return destination;
  try {
    await fs.access(path.join(destination, 'manifest.json'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.cp(MCP_EXTENSION_SOURCE, destination, { recursive: true, force: true });
  }
  return destination;
}

async function installExtensionForEnvironment(environment) {
  if (extensionInstallPromises.has(environment.id)) return extensionInstallPromises.get(environment.id);
  const task = (async () => {
    const destination = path.join(extensionRoot(), `image-bridge-${environment.id}`);
    await fs.mkdir(extensionRoot(), { recursive: true });
    await syncExtensionSource(destination);
    const managedConfig = `export default ${JSON.stringify(bridgeConfigForEnvironment(environment), null, 2)};\n`;
    const managedConfigPath = path.join(destination, 'managed-config.js');
    const installedConfig = await fs.readFile(managedConfigPath, 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error));
    if (installedConfig !== managedConfig) await fs.writeFile(managedConfigPath, managedConfig, 'utf8');
    return { destination, signature: managedConfig };
  })().finally(() => {
    if (extensionInstallPromises.get(environment.id) === task) extensionInstallPromises.delete(environment.id);
  });
  extensionInstallPromises.set(environment.id, task);
  return task;
}

async function loadImageBridgeExtension(browserSession, environment, { force = false } = {}) {
  const { destination, signature } = await installExtensionForEnvironment(environment);
  const loaded = browserSession.getAllExtensions().find((extension) => extension.name === 'GPT Set Image Bridge');
  if (!force && loaded && extensionSignatures.get(environment.id) === signature) return loaded;
  if (loaded) await browserSession.removeExtension(loaded.id);
  const extension = await browserSession.loadExtension(destination, { allowFileAccess: true });
  extensionSignatures.set(environment.id, signature);
  return extension;
}

async function unloadImageBridgeExtension(browserSession, environment) {
  const loaded = browserSession.getAllExtensions().find((extension) => extension.name === 'GPT Set Image Bridge');
  if (loaded) await browserSession.removeExtension(loaded.id);
  extensionSignatures.delete(environment.id);
}

async function applyImageBridgeExtension(environment, { force = false } = {}) {
  const browserSession = session.fromPartition(environment.partition);
  if (environment.imageBridgeEnabled === false) {
    await unloadImageBridgeExtension(browserSession, environment);
    return;
  }
  await loadImageBridgeExtension(browserSession, environment, { force });
}

async function syncImageBridgeForInstance(instanceId) {
  const targets = environments.filter((environment) => environment.mcpInstanceId === instanceId && activeEnvironmentSessions.has(environment.id));
  await Promise.allSettled(targets.map((environment) => applyImageBridgeExtension(environment, { force: true })));
}

function configureChildWindow(child, environment) {
  if (!environmentWindows.has(environment.id)) environmentWindows.set(environment.id, new Set());
  environmentWindows.get(environment.id).add(child);
  child.on('closed', () => {
    const windows = environmentWindows.get(environment.id);
    windows?.delete(child);
    if (!windows?.size) environmentWindows.delete(environment.id);
  });
  child.removeMenu();
  child.webContents.setUserAgent(chromiumUserAgent());
  child.webContents.on('will-navigate', (event, url) => {
    if (url !== 'about:blank' && !url.startsWith('https://')) event.preventDefault();
  });
  child.webContents.setWindowOpenHandler(({ url }) => securePopupOptions(url, environment));
  child.webContents.on('did-create-window', (nested) => configureChildWindow(nested, environment));
}

function securePopupOptions(url, environment) {
  try {
    const blankBootstrap = !url || url === 'about:blank';
    const target = blankBootstrap ? null : new URL(url);
    if (target && target.protocol !== 'https:') return { action: 'deny' };
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 1120,
        height: 820,
        webPreferences: {
          partition: environment.partition,
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          webSecurity: true,
        },
      },
    };
  } catch {
    return { action: 'deny' };
  }
}

async function openEnvironment(id) {
  const environment = findEnvironment(id);
  const browserSession = session.fromPartition(environment.partition);
  activeEnvironmentSessions.add(environment.id);
  configureSession(browserSession);
  if (environment.imageBridgeEnabled !== false) await loadImageBridgeExtension(browserSession, environment);
  browserSession.setUserAgent(chromiumUserAgent());
  const proxyRules = environment.proxy ? normalizeProxy(environment.proxy) : '';
  await browserSession.setProxy(proxyRules ? { proxyRules } : { mode: 'system' });

  const win = new BrowserWindow({
    width: environment.windowBounds?.width || 1280,
    height: environment.windowBounds?.height || 900,
    minWidth: 720,
    minHeight: 520,
    title: `GPT Set · ${environment.name}`,
    webPreferences: {
      partition: environment.partition,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  if (!environmentWindows.has(environment.id)) environmentWindows.set(environment.id, new Set());
  environmentWindows.get(environment.id).add(win);
  win.removeMenu();
  win.webContents.setUserAgent(chromiumUserAgent());
  win.webContents.setWindowOpenHandler(({ url }) => securePopupOptions(url, environment));
  win.webContents.on('did-create-window', (child) => configureChildWindow(child, environment));
  win.on('close', () => {
    const bounds = win.getBounds();
    const existing = environments.find((item) => item.id === environment.id);
    if (existing) {
      existing.windowBounds = { width: bounds.width, height: bounds.height };
      persistEnvironments().catch(console.error);
    }
  });
  win.on('closed', () => {
    const windows = environmentWindows.get(environment.id);
    windows?.delete(win);
    if (!windows?.size) environmentWindows.delete(environment.id);
  });
  environment.lastOpenedAt = new Date().toISOString();
  await persistEnvironments();
  let loadError = '';
  try {
    await win.loadURL(environment.baseUrl);
  } catch (error) {
    loadError = `${error.code || 'LOAD_ERROR'}: ${error.message}`;
    console.error(`环境「${environment.name}」加载失败:`, error);
  }
  return { opened: true, loadError };
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 640,
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

function registerMcpHandlers() {
  ipcMain.handle('mcp:list', () => mcpManager.list());
  ipcMain.handle('mcp:create', async (_event, input) => mcpManager.create(input));
  ipcMain.handle('mcp:update', async (_event, id, input) => {
    try {
      return await mcpManager.update(id, input);
    } finally {
      await syncImageBridgeForInstance(id);
    }
  });
  ipcMain.handle('mcp:delete', async (_event, id) => {
    const fallback = mcpManager.instances.find((instance) => instance.id !== id)?.id || '';
    const affected = environments.filter((environment) => environment.mcpInstanceId === id);
    for (const environment of affected) environment.mcpInstanceId = fallback;
    try {
      if (affected.length) await persistEnvironments();
    } catch (error) {
      for (const environment of affected) environment.mcpInstanceId = id;
      throw error;
    }
    let result;
    try {
      result = await mcpManager.remove(id);
    } catch (error) {
      for (const environment of affected) environment.mcpInstanceId = id;
      if (affected.length) await persistEnvironments();
      throw error;
    }
    await Promise.allSettled(affected.filter((environment) => activeEnvironmentSessions.has(environment.id))
      .map((environment) => applyImageBridgeExtension(environment, { force: true })));
    return result;
  });
  ipcMain.handle('mcp:findPort', (_event, preferred) => mcpManager.findAvailablePort(preferred));
  ipcMain.handle('mcp:pickWorkspace', async (_event, defaultPath) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 MCP 工作目录', defaultPath: defaultPath || mcpManager.defaultWorkspace,
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? '' : (result.filePaths[0] || '');
  });
  ipcMain.handle('mcp:start', (_event, id) => mcpManager.start(id));
  ipcMain.handle('mcp:stop', (_event, id) => mcpManager.stop(id));
  ipcMain.handle('mcp:restart', (_event, id) => mcpManager.restart(id));
  ipcMain.handle('mcp:startTunnel', (_event, id) => mcpManager.startTunnel(id || defaultMcpInstanceId()));
  ipcMain.handle('mcp:stopTunnel', (_event, id) => mcpManager.stopTunnel(id));
  ipcMain.handle('mcp:startAll', () => mcpManager.startAll());
  ipcMain.handle('mcp:stopAll', () => mcpManager.stopAll());
  ipcMain.handle('mcp:rotateToken', async (_event, id) => {
    try {
      return await mcpManager.rotateToken(id);
    } finally {
      await syncImageBridgeForInstance(id);
    }
  });
  ipcMain.handle('mcp:openExtension', async () => {
    const destination = await ensureManualExtensionDirectory();
    const openError = await shell.openPath(destination);
    if (openError) throw new Error(`打开图片桥接扩展目录失败：${openError}`);
    return { path: destination };
  });

  // 兼容旧版渲染器；升级过程中不会因为 IPC 名称变化而丢失控制能力。
  ipcMain.handle('mcp:status', async () => {
    const items = await mcpManager.list();
    const first = items[0] || { running: false, workspaceRoot: '', port: 8787, endpoint: 'http://127.0.0.1:8787/mcp' };
    return { ...first, count: items.length, runningCount: items.filter((item) => item.running).length };
  });
  ipcMain.handle('mcp:chooseWorkspace', async (_event, id) => {
    const target = id ? mcpManager.find(id) : mcpManager.defaultInstance();
    if (!target) return null;
    const selected = await dialog.showOpenDialog(mainWindow, {
      title: '选择 MCP 工作目录', defaultPath: target.workspaceRoot,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (selected.canceled || !selected.filePaths[0]) return null;
    return mcpManager.update(target.id, { ...target, workspaceRoot: selected.filePaths[0] });
  });
}

function registerEnvironmentHandlers() {
  ipcMain.handle('environments:list', () => { assertEnvironmentConfig(); return clone(environments); });
  ipcMain.handle('environments:create', async (_event, input) => {
    const now = new Date().toISOString();
    const id = randomUUID();
    const environment = sanitizeInput(input, { id, partition: `persist:gpt-env-${id}`, createdAt: now, archived: false });
    environments.unshift(environment);
    try { await persistEnvironments(); } catch (error) {
      environments = environments.filter((item) => item.id !== id);
      throw error;
    }
    return clone(environment);
  });
  ipcMain.handle('environments:update', async (_event, id, input) => {
    const environment = findEnvironment(id);
    const original = { ...environment };
    Object.assign(environment, sanitizeInput(input, environment));
    try { await persistEnvironments(); } catch (error) {
      Object.assign(environment, original);
      throw error;
    }
    if (activeEnvironmentSessions.has(id)) await applyImageBridgeExtension(environment, { force: true });
    return clone(environment);
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
    try { await persistEnvironments(); } catch (error) {
      environments = environments.filter((item) => item.id !== newId);
      throw error;
    }
    return clone(copy);
  });
  ipcMain.handle('environments:setArchived', async (_event, id, archived) => {
    const environment = findEnvironment(id);
    const previousArchived = environment.archived;
    environment.archived = Boolean(archived);
    environment.updatedAt = new Date().toISOString();
    try { await persistEnvironments(); } catch (error) {
      environment.archived = previousArchived;
      throw error;
    }
  });
  ipcMain.handle('environments:open', (_event, id) => openEnvironment(id));
  ipcMain.handle('environments:wipe', async (_event, id) => {
    const environment = findEnvironment(id);
    const browserSession = session.fromPartition(environment.partition);
    await browserSession.clearStorageData({ storages: ['cookies', 'filesystem', 'indexdb', 'localstorage', 'serviceworkers', 'cache_storage', 'websql'] });
    await browserSession.clearCache();
  });
  ipcMain.handle('environments:delete', async (_event, id) => {
    const environment = findEnvironment(id);
    const nextEnvironments = environments.filter((item) => item.id !== environment.id);
    const previousEnvironments = environments;
    environments = nextEnvironments;
    try {
      await persistEnvironments();
    } catch (error) {
      environments = previousEnvironments;
      throw error;
    }
    for (const win of environmentWindows.get(environment.id) || []) {
      if (!win.isDestroyed()) win.destroy();
    }
    environmentWindows.delete(environment.id);
    const browserSession = session.fromPartition(environment.partition);
    const cleanup = await Promise.allSettled([
      browserSession.clearStorageData(),
      browserSession.clearCache(),
      fs.rm(path.join(extensionRoot(), `image-bridge-${environment.id}`), { recursive: true, force: true }),
    ]);
    for (const result of cleanup) {
      if (result.status === 'rejected') console.error(`环境「${environment.name}」删除后清理失败:`, result.reason);
    }
    activeEnvironmentSessions.delete(environment.id);
    extensionSignatures.delete(environment.id);
  });
  ipcMain.handle('environments:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: '导入环境配置', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePaths[0]) return 0;
    const parsed = JSON.parse(stripBom(await fs.readFile(filePaths[0], 'utf8')));
    if (!Array.isArray(parsed.environments)) throw new Error('无效的环境配置文件。');
    const now = new Date().toISOString();
    const imported = parsed.environments.map((item) => {
      const id = randomUUID();
      return sanitizeInput({ ...item, mcpInstanceId: '' }, { id, partition: `persist:gpt-env-${id}`, createdAt: now, archived: false });
    });
    environments.unshift(...imported);
    try { await persistEnvironments(); } catch (error) {
      const importedIds = new Set(imported.map((item) => item.id));
      environments = environments.filter((item) => !importedIds.has(item.id));
      throw error;
    }
    return imported.length;
  });
  ipcMain.handle('environments:export', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: '导出环境配置', defaultPath: 'gpt-set-environments.json', filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return false;
    const safe = environments.map(({ partition, mcpInstanceId, ...environment }) => environment);
    await fs.writeFile(filePath, JSON.stringify({ version: 2, environments: safe }, null, 2), 'utf8');
    return true;
  });
}

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
  mcpManager = new McpManager({ app, projectRoot: PROJECT_ROOT });
  await mcpManager.load();
  await loadEnvironments();
  if (!environmentsConfigError) {
    const fallbackMcpId = defaultMcpInstanceId();
    const migrated = environments.some((environment) => environment.mcpInstanceId === undefined);
    if (migrated) {
      for (const environment of environments) {
        if (environment.mcpInstanceId === undefined) environment.mcpInstanceId = fallbackMcpId;
      }
      await persistEnvironments();
    }
  }
  registerMcpHandlers();
  registerEnvironmentHandlers();
  createMainWindow();
  if (environmentsConfigError) dialog.showErrorBox('环境配置损坏', environmentsConfigError.message);
  for (const instance of mcpManager.instances.filter((item) => item.autoStart)) {
    mcpManager.start(instance.id).catch((error) => console.error(`自动启动 MCP「${instance.name}」失败:`, error));
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
  }).catch((error) => {
    console.error('GPT Set 启动失败:', error);
    dialog.showErrorBox('GPT Set 启动失败', error.message);
    app.quit();
  });
}

app.on('before-quit', () => mcpManager?.shutdown());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
