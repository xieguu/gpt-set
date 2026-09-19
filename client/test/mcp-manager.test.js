const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { McpManager, normalizeWorkspace, stripBom, validatePort } = require('../src/mcp-manager');

function createManager() {
  const manager = new McpManager({
    app: { getPath: () => process.cwd() },
    projectRoot: path.resolve(__dirname, '..', '..'),
  });
  manager.instances = [{
    id: 'one', name: 'One', workspaceRoot: process.cwd(),
    port: 18787, token: 'test-token', authMode: 'bearer',
  }];
  return manager;
}

function deferred() {
  let resolve;
  const promise = new Promise((release) => { resolve = release; });
  return { promise, resolve };
}

test('port validation accepts user ports and rejects invalid values', () => {
  assert.equal(validatePort('8787'), 8787);
  assert.throws(() => validatePort(80), /1024/);
  assert.throws(() => validatePort(70000), /65535/);
  assert.throws(() => validatePort('not-a-port'), /端口/);
});

test('workspace validation rejects an empty path and drive root', () => {
  assert.throws(() => normalizeWorkspace(''), /工作目录/);
  assert.throws(() => normalizeWorkspace(path.parse(process.cwd()).root), /磁盘根目录/);
  assert.equal(normalizeWorkspace(path.join(process.cwd(), 'workspace')), path.join(process.cwd(), 'workspace'));
});

test('BOM is removed before JSON parsing', () => {
  assert.deepEqual(JSON.parse(stripBom('\uFEFF{"ok":true}')), { ok: true });
});

test('manager coalesces overlapping status refreshes', async () => {
  const fakeApp = { getPath: () => process.cwd() };
  const manager = new McpManager({ app: fakeApp, projectRoot: path.resolve(__dirname, '..', '..') });
  manager.instances = [
    { id: 'one', name: 'One', workspaceRoot: process.cwd(), port: 18787, token: 'one', authMode: 'bearer' },
    { id: 'two', name: 'Two', workspaceRoot: process.cwd(), port: 18788, token: 'two', authMode: 'bearer' },
  ];
  let refreshCount = 0;
  let releaseRefresh;
  const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
  manager.refresh = async (instance) => {
    refreshCount += 1;
    await refreshGate;
    return { id: instance.id };
  };
  manager.view = (instance) => ({ id: instance.id });

  const first = manager.list();
  const second = manager.list();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshCount, 2);
  releaseRefresh();
  const expected = [{ id: 'one' }, { id: 'two' }];
  assert.deepEqual(await first, expected);
  assert.deepEqual(await second, expected);
  assert.equal(manager.listRefreshPromise, null);
});

test('status snapshots isolate log arrays without dropping values', () => {
  const manager = createManager();
  const instance = manager.instances[0];
  const runtime = manager.runtime(instance.id);
  runtime.logs.push('service log');
  runtime.tunnelLogs.push('tunnel log');
  const snapshot = manager.view(instance);
  assert.deepEqual(snapshot.logs, ['service log']);
  assert.deepEqual(snapshot.tunnel.logs, ['tunnel log']);
  snapshot.logs.push('changed');
  snapshot.tunnel.logs.length = 0;
  assert.deepEqual(runtime.logs, ['service log']);
  assert.deepEqual(runtime.tunnelLogs, ['tunnel log']);
});

for (const phase of ['starting', 'stopping']) {
  test(`status refresh does not probe an instance while ${phase}`, async (context) => {
    const manager = createManager();
    const instance = manager.instances[0];
    const runtime = manager.runtime(instance.id);
    runtime.state = phase;
    runtime.startPromise = phase === 'starting' ? Promise.resolve() : null;
    runtime.stopping = phase === 'stopping';
    const probe = context.mock.method(manager, 'probe', async () => ({ ok: false }));
    assert.equal((await manager.refresh(instance)).state, phase);
    assert.equal(probe.mock.callCount(), 0);
  });
}

test('a stale health check cannot resurrect a stopped process', async (context) => {
  const manager = createManager();
  const instance = manager.instances[0];
  const runtime = manager.runtime(instance.id);
  runtime.state = 'running';
  runtime.managed = true;
  runtime.process = { exitCode: null };
  const gate = deferred();
  context.mock.method(manager, 'probe', () => gate.promise);
  context.mock.method(manager, 'terminate', async (child) => { child.exitCode = 0; });
  const refresh = manager.refresh(instance);
  await manager.stop(instance.id);
  gate.resolve({ ok: true });
  assert.equal((await refresh).state, 'stopped');
  assert.equal(runtime.managed, false);
});

test('a stale health check cannot recreate a removed runtime', async (context) => {
  const manager = createManager();
  const instance = manager.instances[0];
  const gate = deferred();
  context.mock.method(manager, 'probe', () => gate.promise);
  context.mock.method(manager, 'persist', async () => {});
  const refresh = manager.refresh(instance);
  await manager.remove(instance.id);
  gate.resolve({ ok: true });
  await refresh;
  assert.equal(manager.runtimes.has(instance.id), false);
});

test('the newest health check wins when probes complete out of order', async (context) => {
  const manager = createManager();
  const instance = manager.instances[0];
  const older = deferred();
  const newer = deferred();
  let probeCount = 0;
  context.mock.method(manager, 'probe', () => (++probeCount === 1 ? older.promise : newer.promise));
  const firstRefresh = manager.refresh(instance);
  const secondRefresh = manager.refresh(instance);
  newer.resolve({ ok: false, occupied: false });
  await secondRefresh;
  older.resolve({ ok: true });
  assert.equal((await firstRefresh).state, 'stopped');
});

test('list returns the current collection after an overlapping removal', async (context) => {
  const manager = createManager();
  const gate = deferred();
  context.mock.method(manager, 'refresh', async (instance) => {
    await gate.promise;
    return { id: instance.id };
  });
  const listing = manager.list();
  manager.instances = [];
  gate.resolve();
  assert.deepEqual(await listing, []);
});

test('termination clears escalation timers when the child exits immediately', async (context) => {
  const manager = createManager();
  const timers = new Set();
  context.mock.method(global, 'setTimeout', (callback) => {
    const timer = { callback };
    timers.add(timer);
    return timer;
  });
  context.mock.method(global, 'clearTimeout', (timer) => { timers.delete(timer); });
  const child = new EventEmitter();
  child.exitCode = null;
  child.kill = () => {
    child.exitCode = 0;
    child.emit('exit', 0);
    return true;
  };
  await manager.terminate(child);
  assert.equal(timers.size, 0);
  assert.equal(child.listenerCount('exit'), 0);
});

for (const failure of ['kill error', 'timeout']) {
  test(`termination reports ${failure} and releases timers and listeners`, async (context) => {
    const manager = createManager();
    const timers = new Set();
    context.mock.method(global, 'setTimeout', (callback, delay) => {
      const timer = { callback, delay };
      timers.add(timer);
      return timer;
    });
    context.mock.method(global, 'clearTimeout', (timer) => { timers.delete(timer); });
    const child = new EventEmitter();
    child.exitCode = null;
    child.kill = () => {
      if (failure === 'kill error') throw new Error('Cannot terminate');
      return true;
    };
    const termination = manager.terminate(child);
    const rejected = assert.rejects(termination);
    if (failure === 'timeout') [...timers].find((timer) => timer.delay === 4500).callback();
    await rejected;
    assert.equal(timers.size, 0);
    assert.equal(child.listenerCount('exit'), 0);
  });
}

test('failed stops retain process ownership and release lifecycle flags', async (context) => {
  const manager = createManager();
  const runtime = manager.runtime('one');
  const child = { exitCode: null };
  runtime.state = 'running';
  runtime.process = child;
  runtime.managed = true;
  context.mock.method(manager, 'terminate', async () => { throw new Error('Cannot terminate'); });
  await assert.rejects(manager.stop('one'), /Cannot terminate/);
  assert.equal(runtime.process, child);
  assert.equal(runtime.managed, true);
  assert.equal(runtime.stopping, false);
  assert.equal(runtime.cancelStart, false);

  runtime.tunnelProcess = child;
  runtime.tunnelState = 'running';
  await assert.rejects(manager.stopTunnel('one'), /Cannot terminate/);
  assert.equal(runtime.tunnelProcess, child);
  assert.equal(runtime.tunnelState, 'running');
  assert.equal(runtime.cancelTunnel, false);
});

test('manager restores a damaged config from backup without losing instances', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-set-manager-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const userData = path.join(root, 'user-data');
  const documents = path.join(root, 'documents');
  await fs.mkdir(userData, { recursive: true });
  await fs.mkdir(documents, { recursive: true });
  const instance = {
    id: 'backup-instance',
    name: 'Backup instance',
    workspaceRoot: path.join(documents, 'workspace'),
    port: 18787,
    token: 'test-token',
    authMode: 'bearer',
    autoStart: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const configFile = path.join(userData, 'mcp-instances.json');
  await fs.writeFile(configFile, '{ broken json', 'utf8');
  await fs.writeFile(`${configFile}.bak`, JSON.stringify({ version: 1, instances: [instance] }), 'utf8');
  const fakeApp = { getPath: (name) => name === 'userData' ? userData : documents };
  const manager = new McpManager({ app: fakeApp, projectRoot: path.resolve(__dirname, '..', '..') });
  await manager.load();
  assert.equal(manager.instances.length, 1);
  assert.equal(manager.instances[0].id, instance.id);
  assert.doesNotThrow(() => JSON.parse(stripBom(require('node:fs').readFileSync(configFile, 'utf8'))));
});
