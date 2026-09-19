const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');

const SERVICE_NAME = 'gpt-set-local-files';
const CONFIG_VERSION = 1;
const MIN_PORT = 1024;
const MAX_PORT = 65535;
const MAX_LOG_LINES = 240;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const clone = (value) => JSON.parse(JSON.stringify(value));

function stripBom(value) {
  return String(value).replace(/^\uFEFF/, '');
}

function parseEnv(value) {
  const result = {};
  for (const sourceLine of stripBom(value).split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    result[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return result;
}

function validatePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(`端口必须是 ${MIN_PORT}–${MAX_PORT} 之间的整数。`);
  }
  return port;
}

function normalizeWorkspace(value) {
  const workspaceRoot = path.resolve(String(value || '').trim());
  if (!String(value || '').trim()) throw new Error('必须选择本地工作目录。');
  if (workspaceRoot === path.parse(workspaceRoot).root) throw new Error('工作目录不能是磁盘根目录。');
  return workspaceRoot;
}

function normalizeName(value) {
  const name = String(value || '').trim();
  if (!name || name.length > 80) throw new Error('实例名称必须为 1–80 个字符。');
  return name;
}

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

function appendLog(runtime, line, target = 'logs') {
  const values = String(line).split(/\r?\n/).filter(Boolean);
  runtime[target].push(...values);
  runtime[target] = runtime[target].slice(-MAX_LOG_LINES);
}

function attachOutput(stream, callback) {
  if (!stream) return;
  stream.setEncoding('utf8');
  stream.on('data', callback);
}

class McpManager {
  constructor({ app, projectRoot }) {
    this.app = app;
    this.serverRoot = path.join(projectRoot, 'local-mcp-server');
    this.configFile = path.join(app.getPath('userData'), 'mcp-instances.json');
    this.defaultWorkspace = path.join(app.getPath('documents'), 'GPT-Workspace');
    this.instances = [];
    this.runtimes = new Map();
    this.persistQueue = Promise.resolve();
    this.listRefreshPromise = null;
  }

  token() {
    return randomBytes(32).toString('base64url');
  }

  runtime(id) {
    if (!this.runtimes.has(id)) {
      this.runtimes.set(id, {
        state: 'stopped', process: null, managed: false, startPromise: null,
        error: '', logs: [], startedAt: null, stopping: false,
        cancelStart: false, statusVersion: 0,
        tunnelState: 'stopped', tunnelProcess: null, tunnelStartPromise: null,
        tunnelError: '', tunnelLogs: [], tunnelUrl: '', tunnelBuffer: '', cancelTunnel: false,
      });
    }
    return this.runtimes.get(id);
  }

  find(id) {
    const instance = this.instances.find((item) => item.id === id);
    if (!instance) throw new Error('MCP 实例不存在。');
    return instance;
  }

  defaultInstance() {
    return this.instances[0] || null;
  }

  normalizeStored(data) {
    if (!data || !Array.isArray(data.instances)) throw new Error('MCP 实例配置格式无效。');
    const ids = new Set();
    const ports = new Set();
    return data.instances.map((item) => {
      const id = String(item.id || '').trim();
      if (!id || ids.has(id)) throw new Error('MCP 实例 ID 无效或重复。');
      ids.add(id);
      const port = validatePort(item.port);
      if (ports.has(port)) throw new Error(`MCP 端口 ${port} 重复。`);
      ports.add(port);
      return {
        id,
        name: normalizeName(item.name),
        workspaceRoot: normalizeWorkspace(item.workspaceRoot),
        port,
        token: String(item.token || '') || this.token(),
        authMode: item.authMode === 'none' ? 'none' : 'bearer',
        autoStart: item.autoStart !== false,
        createdAt: item.createdAt || new Date().toISOString(),
        updatedAt: item.updatedAt || new Date().toISOString(),
      };
    });
  }

  async makeLegacyDefault() {
    let values = {};
    try {
      values = parseEnv(await fs.readFile(path.join(this.serverRoot, '.env'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('读取旧 MCP .env 失败:', error);
    }
    let port = Number(values.PORT || 8787);
    if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) port = 8787;
    const configuredToken = String(values.MCP_TOKEN || '');
    const weakLegacyToken = !configuredToken
      || configuredToken.startsWith('replace-with-')
      || configuredToken === 'local-dev-token-change-before-tunnel'
      || configuredToken.length < 24;
    return {
      id: randomUUID(),
      name: '默认工作区',
      workspaceRoot: normalizeWorkspace(values.WORKSPACE_ROOT || this.defaultWorkspace),
      port,
      token: weakLegacyToken ? this.token() : configuredToken,
      authMode: values.AUTH_MODE === 'none' ? 'none' : 'bearer',
      autoStart: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  async load() {
    try {
      const parsed = JSON.parse(stripBom(await fs.readFile(this.configFile, 'utf8')));
      this.instances = this.normalizeStored(parsed);
      return;
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.instances = [await this.makeLegacyDefault()];
        await this.persist();
        return;
      }
      console.error('MCP 配置读取失败，尝试备份:', error);
    }

    try {
      const parsed = JSON.parse(stripBom(await fs.readFile(`${this.configFile}.bak`, 'utf8')));
      this.instances = this.normalizeStored(parsed);
      const corrupt = `${this.configFile}.corrupt-${Date.now()}`;
      await fs.rename(this.configFile, corrupt).catch(() => {});
      await this.persist();
    } catch (backupError) {
      throw new Error(`MCP 配置和备份都无法读取：${backupError.message}`);
    }
  }

  async persist() {
    const snapshot = clone({ version: CONFIG_VERSION, instances: this.instances });
    const task = this.persistQueue.then(() => atomicWriteJson(this.configFile, snapshot));
    this.persistQueue = task.catch(() => {});
    await task;
  }

  assertUniquePort(port, exceptId = '') {
    if (this.instances.some((item) => item.id !== exceptId && item.port === port)) {
      throw new Error(`端口 ${port} 已分配给其他 MCP 实例。`);
    }
  }

  async isPortListening(port) {
    return new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      const done = (value) => { socket.destroy(); resolve(value); };
      socket.setTimeout(700);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
    });
  }

  async findAvailablePort(preferred = 8787) {
    let start = Number(preferred);
    if (!Number.isInteger(start) || start < MIN_PORT || start > MAX_PORT) start = 8787;
    const assigned = new Set(this.instances.map((item) => item.port));
    for (let offset = 0; offset <= MAX_PORT - MIN_PORT; offset += 1) {
      const candidate = MIN_PORT + ((start - MIN_PORT + offset) % (MAX_PORT - MIN_PORT + 1));
      if (!assigned.has(candidate) && !(await this.isPortListening(candidate))) return candidate;
    }
    throw new Error('没有找到可用端口。');
  }

  async probe(instance, timeout = 1200) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(`http://127.0.0.1:${instance.port}/health`, {
        headers: { 'X-MCP-Token': instance.token }, signal: controller.signal, cache: 'no-store',
      });
      if (!response.ok) return { ok: false, occupied: true, reason: `健康检查返回 HTTP ${response.status}` };
      const data = await response.json();
      if (data.service !== SERVICE_NAME) return { ok: false, occupied: true, reason: '端口被其他 HTTP 服务占用' };
      if (data.instanceId && data.instanceId !== instance.id) {
        return { ok: false, occupied: true, reason: `端口属于另一个 MCP 实例（${data.instanceId}）` };
      }
      return { ok: true, occupied: true, data };
    } catch (error) {
      return { ok: false, occupied: await this.isPortListening(instance.port), reason: error.name === 'AbortError' ? '健康检查超时' : error.message };
    } finally {
      clearTimeout(timer);
    }
  }

  publicAddress(instance, runtime) {
    if (!runtime.tunnelUrl) return '';
    const suffix = instance.authMode === 'bearer' ? `?token=${encodeURIComponent(instance.token)}` : '';
    return `${runtime.tunnelUrl}/mcp${suffix}`;
  }

  view(instance) {
    const runtime = this.runtime(instance.id);
    const running = runtime.state === 'running' || runtime.state === 'external';
    return {
      id: instance.id,
      name: instance.name,
      workspaceRoot: instance.workspaceRoot,
      port: instance.port,
      endpoint: `http://127.0.0.1:${instance.port}/mcp`,
      captureEndpoint: `http://127.0.0.1:${instance.port}/bridge/capture`,
      authMode: instance.authMode,
      tokenMasked: instance.token ? `${instance.token.slice(0, 4)}…${instance.token.slice(-4)}` : '',
      autoStart: instance.autoStart,
      createdAt: instance.createdAt,
      updatedAt: instance.updatedAt,
      running,
      managed: runtime.managed,
      state: runtime.state,
      pid: runtime.process?.pid || null,
      error: runtime.error,
      logs: [...runtime.logs],
      startedAt: runtime.startedAt,
      tunnel: {
        running: runtime.tunnelState === 'running',
        state: runtime.tunnelState,
        pid: runtime.tunnelProcess?.pid || null,
        url: runtime.tunnelUrl,
        publicAddress: this.publicAddress(instance, runtime),
        error: runtime.tunnelError,
        logs: [...runtime.tunnelLogs],
      },
    };
  }

  async refresh(instance) {
    const runtime = this.runtime(instance.id);
    if (runtime.startPromise || runtime.stopping) return this.view(instance);
    const statusVersion = ++runtime.statusVersion;
    const result = await this.probe(instance, 800);
    if (this.runtimes.get(instance.id) !== runtime) return null;
    if (runtime.statusVersion !== statusVersion) return this.view(instance);
    const childAlive = runtime.process && runtime.process.exitCode === null;
    if (result.ok) {
      runtime.state = childAlive ? 'running' : 'external';
      runtime.managed = Boolean(childAlive);
      runtime.error = '';
    } else if (childAlive) {
      runtime.state = 'unhealthy';
      runtime.managed = true;
      runtime.error = result.reason || 'MCP 进程存在，但健康检查失败。';
    } else if (!childAlive && runtime.state !== 'failed') {
      runtime.state = result.occupied ? 'conflict' : 'stopped';
      runtime.managed = false;
      runtime.error = result.occupied ? result.reason : '';
    }
    return this.view(instance);
  }

  async list({ refresh = true } = {}) {
    if (!refresh) return this.instances.map((instance) => this.view(instance));
    if (!this.listRefreshPromise) {
      this.listRefreshPromise = Promise.all(this.instances.map((instance) => this.refresh(instance)))
        .then(() => this.instances.map((instance) => this.view(instance)))
        .finally(() => { this.listRefreshPromise = null; });
    }
    return this.listRefreshPromise;
  }

  async create(input) {
    const port = input.port ? validatePort(input.port) : await this.findAvailablePort(8787);
    this.assertUniquePort(port);
    const now = new Date().toISOString();
    const instance = {
      id: randomUUID(), name: normalizeName(input.name), workspaceRoot: normalizeWorkspace(input.workspaceRoot),
      port, token: this.token(), authMode: 'bearer', autoStart: Boolean(input.autoStart),
      createdAt: now, updatedAt: now,
    };
    await fs.mkdir(instance.workspaceRoot, { recursive: true });
    this.instances.push(instance);
    try {
      await this.persist();
    } catch (error) {
      this.instances = this.instances.filter((item) => item.id !== instance.id);
      throw error;
    }
    if (instance.autoStart) {
      try { await this.start(instance.id); } catch { /* 实例保留在列表中并显示启动错误。 */ }
    }
    return this.view(instance);
  }

  async update(id, input) {
    const instance = this.find(id);
    const original = { ...instance };
    const runtime = this.runtime(id);
    const port = validatePort(input.port ?? instance.port);
    this.assertUniquePort(port, id);
    const next = {
      ...instance,
      name: normalizeName(input.name ?? instance.name),
      workspaceRoot: normalizeWorkspace(input.workspaceRoot ?? instance.workspaceRoot),
      port,
      autoStart: input.autoStart === undefined ? instance.autoStart : Boolean(input.autoStart),
      updatedAt: new Date().toISOString(),
    };
    const needsRestart = next.port !== instance.port || next.workspaceRoot !== instance.workspaceRoot;
    if (needsRestart) await this.refresh(instance);
    const wasManaged = runtime.managed && runtime.process?.exitCode === null;
    if (needsRestart && runtime.state === 'external') throw new Error('此实例由外部进程运行，无法自动更改端口或目录。');
    if (needsRestart && wasManaged) await this.stop(id);
    runtime.statusVersion += 1;
    Object.assign(instance, next);
    await fs.mkdir(instance.workspaceRoot, { recursive: true });
    try {
      await this.persist();
    } catch (error) {
      runtime.statusVersion += 1;
      Object.assign(instance, original);
      if (needsRestart && wasManaged) await this.start(id).catch(() => {});
      throw error;
    }
    if (needsRestart && wasManaged) await this.start(id);
    return this.view(instance);
  }

  async remove(id) {
    const instance = this.find(id);
    const runtime = this.runtime(id);
    if (runtime.state === 'external') throw new Error('实例由外部进程运行，请先手动停止该进程。');
    await this.stop(id);
    const previousInstances = this.instances;
    this.instances = this.instances.filter((item) => item.id !== id);
    try {
      await this.persist();
    } catch (error) {
      this.instances = previousInstances;
      throw error;
    }
    this.runtimes.delete(id);
    return { removed: true, id: instance.id };
  }

  childEnvironment(instance) {
    return {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      INSTANCE_ID: instance.id,
      WORKSPACE_ROOT: instance.workspaceRoot,
      HOST: '127.0.0.1',
      PORT: String(instance.port),
      MCP_TOKEN: instance.token,
      AUTH_MODE: instance.authMode,
    };
  }

  async start(id) {
    const instance = this.find(id);
    const runtime = this.runtime(id);
    if (runtime.startPromise) return runtime.startPromise;
    runtime.statusVersion += 1;
    runtime.cancelStart = false;
    runtime.startPromise = (async () => {
      const current = await this.probe(instance);
      if (runtime.cancelStart) throw new Error('MCP 启动已取消。');
      if (current.ok) {
        const childAlive = runtime.process && runtime.process.exitCode === null;
        runtime.state = childAlive ? 'running' : 'external';
        runtime.managed = Boolean(childAlive);
        runtime.error = '';
        return this.view(instance);
      }
      if (current.occupied) {
        runtime.state = 'conflict';
        runtime.error = current.reason;
        throw new Error(`端口 ${instance.port} 已被占用：${current.reason}`);
      }

      await fs.mkdir(instance.workspaceRoot, { recursive: true });
      runtime.logs = [];
      runtime.error = '';
      runtime.state = 'starting';
      runtime.stopping = false;
      appendLog(runtime, `$ MCP ${instance.name} · 127.0.0.1:${instance.port}`);
      const child = spawn(process.execPath, ['src/server.js'], {
        cwd: this.serverRoot,
        env: this.childEnvironment(instance),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      runtime.process = child;
      runtime.managed = true;
      runtime.startedAt = new Date().toISOString();
      let spawnError = null;
      attachOutput(child.stdout, (chunk) => appendLog(runtime, chunk));
      attachOutput(child.stderr, (chunk) => appendLog(runtime, chunk));
      child.once('error', (error) => { spawnError = error; appendLog(runtime, `启动错误：${error.message}`); });
      child.once('exit', (code, signal) => {
        if (runtime.process !== child) return;
        runtime.statusVersion += 1;
        runtime.process = null;
        runtime.managed = false;
        appendLog(runtime, `MCP 进程已退出：code=${code ?? '-'} signal=${signal ?? '-'}`);
        if (!runtime.stopping && runtime.state !== 'failed') {
          runtime.state = code === 0 ? 'stopped' : 'failed';
          runtime.error = code === 0 ? '' : `MCP 进程异常退出（code=${code}）`;
        }
      });

      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        if (runtime.cancelStart) throw new Error('MCP 启动已取消。');
        if (spawnError) throw spawnError;
        if (child.exitCode !== null) throw new Error(`MCP 进程提前退出（code=${child.exitCode}）。`);
        const health = await this.probe(instance, 600);
        if (health.ok) {
          runtime.state = 'running';
          runtime.error = '';
          return this.view(instance);
        }
        await sleep(180);
      }
      throw new Error('MCP 服务启动超时，请查看实例日志。');
    })().catch(async (error) => {
      const cancelled = runtime.cancelStart;
      runtime.state = cancelled ? 'stopped' : 'failed';
      runtime.error = cancelled ? '' : error.message;
      appendLog(runtime, cancelled ? 'MCP 启动已取消。' : `启动失败：${error.message}`);
      if (runtime.process?.exitCode === null) await this.terminate(runtime.process);
      runtime.process = null;
      runtime.managed = false;
      throw error;
    }).finally(() => { runtime.startPromise = null; });
    return runtime.startPromise;
  }

  async terminate(child) {
    if (!child || child.exitCode !== null || child.signalCode) return;
    await new Promise((resolve, reject) => {
      let finished = false;
      let forceTimer;
      let deadlineTimer;
      const done = (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(forceTimer);
        clearTimeout(deadlineTimer);
        child.removeListener('exit', onExit);
        if (error) reject(error);
        else resolve();
      };
      const onExit = () => done();
      child.once('exit', onExit);
      forceTimer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode) return done();
        if (process.platform === 'win32' && child.pid) {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.once('exit', (code) => {
            if (code !== 0 && child.exitCode === null && !child.signalCode) {
              done(new Error(`结束 MCP 进程失败（taskkill code=${code}）。`));
            }
          });
          killer.once('error', done);
        } else {
          try {
            child.kill('SIGKILL');
          } catch (error) {
            done(error);
          }
        }
      }, 1800);
      deadlineTimer = setTimeout(() => done(new Error('停止 MCP 进程超时。')), 4500);
      try {
        child.kill();
      } catch (error) {
        done(error);
      }
    });
  }

  async stop(id) {
    const instance = this.find(id);
    const runtime = this.runtime(id);
    runtime.statusVersion += 1;
    runtime.cancelStart = true;
    runtime.stopping = true;
    try {
      if (runtime.startPromise) await runtime.startPromise.catch(() => {});
      await this.stopTunnel(id);
      if (runtime.state === 'external') {
        throw new Error('此实例不是由 GPT Set 启动，无法从这里停止。');
      }
      if (runtime.process) await this.terminate(runtime.process);
      runtime.process = null;
      runtime.managed = false;
      runtime.state = 'stopped';
      runtime.error = '';
      appendLog(runtime, `已停止 ${instance.name}。`);
      return this.view(instance);
    } finally {
      runtime.stopping = false;
      runtime.cancelStart = false;
    }
  }

  async restart(id) {
    const runtime = this.runtime(id);
    if (runtime.state === 'external') throw new Error('此实例不是由 GPT Set 启动，无法从这里重启。');
    await this.stop(id);
    return this.start(id);
  }

  async rotateToken(id) {
    const instance = this.find(id);
    const runtime = this.runtime(id);
    if (runtime.state === 'external') throw new Error('外部运行实例无法自动轮换 Token。');
    const wasRunning = runtime.managed && runtime.process?.exitCode === null;
    await this.stopTunnel(id);
    if (wasRunning) await this.stop(id);
    const previousToken = instance.token;
    runtime.statusVersion += 1;
    instance.token = this.token();
    instance.updatedAt = new Date().toISOString();
    try {
      await this.persist();
    } catch (error) {
      runtime.statusVersion += 1;
      instance.token = previousToken;
      if (wasRunning) await this.start(id).catch(() => {});
      throw error;
    }
    if (wasRunning) await this.start(id);
    return this.view(instance);
  }

  async cloudflaredBinary() {
    const candidates = [
      process.env.CLOUDFLARED_PATH,
      'D:\\cloudflared\\cloudflared.exe',
      path.join(this.serverRoot, 'cloudflared.exe'),
    ].filter(Boolean);
    for (const candidate of candidates) {
      try { await fs.access(candidate); return candidate; } catch { /* try next */ }
    }
    return 'cloudflared';
  }

  async startTunnel(id) {
    const instance = this.find(id);
    const runtime = this.runtime(id);
    await this.start(id);
    if (runtime.tunnelState === 'running' && runtime.tunnelProcess?.exitCode === null) return this.view(instance);
    if (runtime.tunnelStartPromise) return runtime.tunnelStartPromise;

    runtime.cancelTunnel = false;
    runtime.tunnelStartPromise = (async () => {
      const binary = await this.cloudflaredBinary();
      runtime.tunnelLogs = [];
      runtime.tunnelError = '';
      runtime.tunnelUrl = '';
      runtime.tunnelBuffer = '';
      runtime.tunnelState = 'starting';
      appendLog(runtime, `$ cloudflared tunnel --protocol http2 --url http://127.0.0.1:${instance.port}`, 'tunnelLogs');
      const child = spawn(binary, ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', `http://127.0.0.1:${instance.port}`], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      runtime.tunnelProcess = child;

      return await new Promise((resolve, reject) => {
        let settled = false;
        const finishError = (error) => {
          if (settled) return;
          settled = true;
          runtime.tunnelState = 'failed';
          runtime.tunnelError = error.message;
          appendLog(runtime, `Tunnel 启动失败：${error.message}`, 'tunnelLogs');
          reject(error);
        };
        const timer = setTimeout(() => finishError(new Error('Tunnel 启动超时，请检查 cloudflared 和网络。')), 45_000);
        const scan = (chunk) => {
          const text = String(chunk);
          appendLog(runtime, text, 'tunnelLogs');
          runtime.tunnelBuffer = `${runtime.tunnelBuffer}${text}`.slice(-4096);
          if (runtime.cancelTunnel) return finishError(new Error('Tunnel 启动已取消。'));
          const match = runtime.tunnelBuffer.match(/https:\/\/[^\s]+\.trycloudflare\.com/);
          if (!match || settled) return;
          settled = true;
          clearTimeout(timer);
          runtime.tunnelUrl = match[0];
          runtime.tunnelState = 'running';
          runtime.tunnelError = '';
          resolve(this.view(instance));
        };
        attachOutput(child.stdout, scan);
        attachOutput(child.stderr, scan);
        child.once('error', (error) => { clearTimeout(timer); finishError(error); });
        child.once('exit', (code, signal) => {
          clearTimeout(timer);
          if (!settled) finishError(new Error(`cloudflared 提前退出（code=${code ?? '-'} signal=${signal ?? '-'}）。`));
          runtime.tunnelProcess = null;
          runtime.tunnelUrl = '';
          if (runtime.tunnelState !== 'failed') runtime.tunnelState = 'stopped';
          appendLog(runtime, `Tunnel 已退出：code=${code ?? '-'} signal=${signal ?? '-'}`, 'tunnelLogs');
        });
      });
    })().catch(async (error) => {
      if (runtime.tunnelProcess?.exitCode === null) await this.terminate(runtime.tunnelProcess);
      runtime.tunnelProcess = null;
      runtime.tunnelUrl = '';
      runtime.tunnelState = runtime.cancelTunnel ? 'stopped' : 'failed';
      runtime.tunnelError = runtime.cancelTunnel ? '' : error.message;
      throw error;
    }).finally(() => { runtime.tunnelStartPromise = null; });
    return runtime.tunnelStartPromise;
  }

  async stopTunnel(id) {
    const instance = this.find(id);
    const runtime = this.runtime(id);
    runtime.cancelTunnel = true;
    try {
      if (runtime.tunnelProcess) await this.terminate(runtime.tunnelProcess);
      if (runtime.tunnelStartPromise) await runtime.tunnelStartPromise.catch(() => {});
      runtime.tunnelProcess = null;
      runtime.tunnelUrl = '';
      runtime.tunnelState = 'stopped';
      runtime.tunnelError = '';
      return this.view(instance);
    } finally {
      runtime.cancelTunnel = false;
    }
  }

  async startAll() {
    const results = await Promise.allSettled(this.instances.map((instance) => this.start(instance.id)));
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length) throw new Error(`${failures.length} 个 MCP 实例启动失败，请查看实例日志。`);
    return this.list({ refresh: false });
  }

  async stopAll() {
    const results = await Promise.allSettled(this.instances.map((instance) => this.stop(instance.id)));
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length) throw new Error(`${failures.length} 个 MCP 实例停止失败，请查看实例状态。`);
    return this.list({ refresh: false });
  }

  shutdown() {
    for (const runtime of this.runtimes.values()) {
      if (runtime.tunnelProcess?.exitCode === null) runtime.tunnelProcess.kill();
      if (runtime.process?.exitCode === null) runtime.process.kill();
    }
  }
}

module.exports = { McpManager, validatePort, normalizeWorkspace, stripBom };
