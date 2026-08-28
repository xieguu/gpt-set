const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { McpManager, normalizeWorkspace, stripBom, validatePort } = require('../src/mcp-manager');

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
