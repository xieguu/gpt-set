const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const { McpManager } = require('../../src/mcp-manager');

const serverRoot = path.resolve(__dirname, '..', '..', '..', 'local-mcp-server');
const serverRequire = createRequire(path.join(serverRoot, 'package.json'));
const { Client } = serverRequire('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = serverRequire('@modelcontextprotocol/sdk/client/streamableHttp.js');
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const TOKEN = 'integration-test-token';

async function startServer(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-set-server-test-'));
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: serverRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: '0', WORKSPACE_ROOT: root,
      AUTH_MODE: 'bearer', MCP_TOKEN: TOKEN, INSTANCE_ID: 'integration-test',
      DOTENV_CONFIG_PATH: path.join(root, '.env'),
    },
  });
  context.after(async () => {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) });
      child.kill();
      await exited;
    }
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('gpt-set-server-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const baseUrl = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${output}`)), 10_000);
    const finish = (error, url) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(url);
    };
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => finish(new Error(`Server exited with ${code}: ${output}`)));
    child.stderr.on('data', (chunk) => { output = `${output}${chunk}`.slice(-4096); });
    child.stdout.on('data', (chunk) => {
      output = `${output}${chunk}`.slice(-4096);
      const match = output.match(/MCP files server: (http:\/\/127\.0\.0\.1:\d+)\/mcp/);
      if (match) finish(null, match[1]);
    });
  });
  return { root, baseUrl };
}

test('local MCP server image and file workflows', { timeout: 60_000 }, async (context) => {
  const { root, baseUrl } = await startServer(context);
  const headers = { 'Content-Type': 'application/json', 'X-MCP-Token': TOKEN };
  const capture = (bytes) => fetch(`${baseUrl}/bridge/capture`, {
    method: 'POST', headers,
    body: JSON.stringify({ mimeType: 'image/png', data: bytes.toString('base64') }),
    signal: AbortSignal.timeout(15_000),
  });

  await context.test('health checks identify the instance and require authentication', async () => {
    const denied = await fetch(`${baseUrl}/health`);
    assert.equal(denied.status, 401);
    await denied.arrayBuffer();
    const response = await fetch(`${baseUrl}/health`, { headers });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).instanceId, 'integration-test');
  });

  await context.test('unauthenticated bodies are rejected before JSON parsing', async () => {
    for (const endpoint of ['/bridge/capture', '/mcp']) {
      const response = await fetch(`${baseUrl}${endpoint}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{ invalid json',
      });
      assert.equal(response.status, 401);
      await response.arrayBuffer();
    }
  });

  await context.test('image preflight remains accessible without a token', async () => {
    const response = await fetch(`${baseUrl}/bridge/capture`, { method: 'OPTIONS' });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
  });

  await context.test('a full 10 MiB image fits after Base64 expansion', async () => {
    const bytes = Buffer.alloc(MAX_IMAGE_BYTES, 0x61);
    const response = await capture(bytes);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    const saved = await fs.readFile(path.join(root, '.chatgpt-image-inbox', result.fileName));
    assert.equal(saved.length, MAX_IMAGE_BYTES);
    assert.ok(saved.equals(bytes));
  });

  await context.test('an image one byte over the limit is rejected without writing', async () => {
    const inbox = path.join(root, '.chatgpt-image-inbox');
    const before = await fs.readdir(inbox);
    const response = await capture(Buffer.alloc(MAX_IMAGE_BYTES + 1));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'Invalid image size');
    assert.deepEqual(await fs.readdir(inbox), before);
  });

  await context.test('MCP SDK tools still round-trip text files', async (scenario) => {
    const client = new Client({ name: 'gpt-set-integration-test', version: '1.0.0' });
    scenario.after(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { 'X-MCP-Token': TOKEN } },
    }));
    const content = 'MCP integration check';
    const written = await client.callTool({ name: 'write_text', arguments: { path: 'roundtrip.txt', content } });
    assert.notEqual(written.isError, true);
    const result = await client.callTool({ name: 'read_file', arguments: { path: 'roundtrip.txt' } });
    assert.notEqual(result.isError, true);
    assert.equal(result.content[0].text, content);
  });

  await context.test('manager starts, restarts and stops a real isolated server', async (scenario) => {
    const manager = new McpManager({
      app: { getPath: () => root },
      projectRoot: path.resolve(serverRoot, '..'),
    });
    const instance = {
      id: 'managed-integration-test', name: 'Managed test',
      workspaceRoot: path.join(root, 'managed-workspace'),
      port: await manager.findAvailablePort(20000), token: TOKEN, authMode: 'bearer',
    };
    manager.instances = [instance];
    scenario.after(() => manager.stopAll());
    const started = await manager.start(instance.id);
    assert.equal(started.state, 'running');
    assert.equal(started.managed, true);
    assert.ok(started.pid > 0);
    const restarted = await manager.restart(instance.id);
    assert.equal(restarted.state, 'running');
    assert.ok(restarted.pid > 0);
    const refreshing = manager.list();
    await manager.stop(instance.id);
    await refreshing;
    const [stopped] = await manager.list({ refresh: false });
    assert.equal(stopped.state, 'stopped');
    assert.equal(stopped.pid, null);
    assert.equal(stopped.managed, false);
  });
});
