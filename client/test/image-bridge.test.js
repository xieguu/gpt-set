const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const extensionRoot = path.resolve(__dirname, '..', '..', 'chatgpt-image-bridge-extension');
const backgroundSource = fs.readFileSync(path.join(extensionRoot, 'background.js'), 'utf8')
  .replace(/^import managedConfig from '.\/managed-config.js';\r?\n/, '');
const contentSource = fs.readFileSync(path.join(extensionRoot, 'content.js'), 'utf8');
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function loadBackground(fetchImplementation, overrides = {}) {
  const context = vm.createContext({
    managedConfig: { managed: true, enabled: true, endpoint: 'http://127.0.0.1:8787/bridge/capture', token: 'test-token' },
    chrome: { runtime: { onMessage: { addListener() {} } } },
    AbortSignal,
    fetch: fetchImplementation,
    ...overrides,
  });
  vm.runInContext(backgroundSource, context, { filename: 'background.js' });
  return context;
}

function loadContent(fetchImplementation, overrides = {}) {
  const context = vm.createContext({
    chrome: { storage: { onChanged: { addListener() {} } } },
    document: { documentElement: {}, querySelectorAll: () => [], addEventListener() {} },
    MutationObserver: class { observe() {} },
    HTMLImageElement: class {},
    location: { href: 'https://chatgpt.com/' },
    console: { debug() {} },
    URL, AbortController, Blob, setTimeout, clearTimeout,
    fetch: fetchImplementation,
    ...overrides,
  });
  vm.runInContext(contentSource, context, { filename: 'content.js' });
  return context;
}

const immediateRetries = {
  setTimeout(callback, delay) {
    if (delay < 20_000) queueMicrotask(callback);
    return callback;
  },
  clearTimeout() {},
};

for (const status of [400, 401, 403, 404, 413, 415, 408, 429, 500, 503]) {
  test(`image uploads classify HTTP ${status} retryability`, async () => {
    const context = loadBackground(async () => new Response('{}', { status }));
    const result = await context.capture({ mimeType: 'image/png', data: 'AQ==' });
    assert.equal(result.ok, false);
    assert.equal(result.status, status);
    assert.equal(result.retryable, status === 408 || status === 429 || status >= 500);
  });
}

test('background upload has a real fetch deadline shorter than the caller timeout', async () => {
  const controller = new AbortController();
  let deadline;
  let uploadSignal;
  const context = loadBackground(async (_url, options) => {
    uploadSignal = options.signal;
    return new Response('{}');
  }, {
    AbortSignal: { timeout(milliseconds) { deadline = milliseconds; return controller.signal; } },
  });
  assert.equal((await context.capture({ data: 'AQ==' })).ok, true);
  assert.equal(uploadSignal, controller.signal);
  assert.equal(deadline, 20_000);
});

test('disabled image capture sends no upload request', async () => {
  let requests = 0;
  const context = loadBackground(async () => { requests += 1; }, {
    managedConfig: { managed: true, enabled: false },
  });
  assert.equal((await context.capture({ data: 'AQ==' })).skipped, true);
  assert.equal(requests, 0);
});

for (const status of [403, 404, 408, 429, 503]) {
  test(`image downloads classify HTTP ${status} retryability`, async () => {
    const context = loadContent(async () => new Response('', { status }));
    await assert.rejects(context.createPayload('https://example.test/image.png'), (error) => {
      assert.equal(error.retryable, status === 408 || status === 429 || status >= 500);
      return true;
    });
  });
}

for (const [name, makeResponse] of [
  ['unsupported MIME', () => new Response('text', { headers: { 'content-type': 'text/plain' } })],
  ['oversized header', () => new Response('', { headers: { 'content-type': 'image/png', 'content-length': MAX_IMAGE_BYTES + 1 } })],
  ['oversized stream', () => new Response(new Uint8Array(MAX_IMAGE_BYTES + 1), { headers: { 'content-type': 'image/png' } })],
  ['empty image', () => new Response(new Uint8Array(), { headers: { 'content-type': 'image/png' } })],
]) {
  test(`image download does not retry ${name}`, async () => {
    const context = loadContent(async () => makeResponse());
    await assert.rejects(context.createPayload('https://example.test/image.png'), (error) => error.retryable === false);
  });
}

test('a permanent download failure performs one request rather than four', async () => {
  let downloads = 0;
  const context = loadContent(async () => {
    downloads += 1;
    return new Response('', { status: 403 });
  }, immediateRetries);
  await context.upload({ source: 'https://example.test/image.png', payload: null });
  assert.equal(downloads, 1);
});

test('transient upload retries reuse the downloaded image and release the payload', async () => {
  const context = loadContent(async () => {}, immediateRetries);
  let downloads = 0;
  let uploads = 0;
  context.createPayload = async () => { downloads += 1; return { mimeType: 'image/png', data: 'AQ==' }; };
  context.sendCapture = async () => {
    uploads += 1;
    return uploads === 1 ? { ok: false, retryable: true, error: 'HTTP 503' } : { ok: true };
  };
  const job = { source: 'https://example.test/image.png', payload: null };
  await context.upload(job);
  assert.equal(downloads, 1);
  assert.equal(uploads, 2);
  assert.equal(job.payload, null);
});
