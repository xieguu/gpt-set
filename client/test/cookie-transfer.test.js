const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FORMAT,
  VERSION,
  buildPackage,
  parsePackage,
  cookieToSetDetails,
} = require('../src/cookie-transfer');

function sampleCookie(overrides = {}) {
  return {
    name: 'session', value: 'secret', domain: '.example.com', hostOnly: false, path: '/', secure: true,
    httpOnly: true, session: false, expirationDate: 2_000_000_000, sameSite: 'no_restriction', ...overrides,
  };
}

function sampleEnvironment() {
  return {
    name: 'Work', provider: 'chatgpt', baseUrl: 'https://chatgpt.com/', proxy: '', locale: 'zh-CN',
    timezone: 'Asia/Shanghai', imageBridgeEnabled: true,
  };
}

test('cookie session package round-trips with a stable format', () => {
  const exportedAt = new Date('2026-09-14T00:00:00.000Z');
  const payload = buildPackage([{ environment: sampleEnvironment(), cookies: [sampleCookie()] }], () => exportedAt);
  assert.equal(payload.format, FORMAT);
  assert.equal(payload.version, VERSION);
  assert.deepEqual(parsePackage(JSON.stringify(payload)), payload);
});

test('cookie package parser rejects unknown fields and invalid domains', () => {
  const payload = buildPackage([{ environment: sampleEnvironment(), cookies: [sampleCookie()] }]);
  assert.throws(() => parsePackage(JSON.stringify({ ...payload, unexpected: true })), /不支持的字段/);
  payload.environments[0].cookies[0].domain = '127.0.0.1/path';
  assert.throws(() => parsePackage(JSON.stringify(payload)), /域名格式无效/);
});

test('cookie set details preserve host-only and persistent semantics', () => {
  const persistent = cookieToSetDetails(sampleCookie());
  assert.equal(persistent.url, 'https://example.com/');
  assert.equal(persistent.domain, '.example.com');
  assert.equal(persistent.expirationDate, 2_000_000_000);
  const hostOnly = cookieToSetDetails(sampleCookie({
    domain: 'chatgpt.com', hostOnly: true, session: true, expirationDate: null, sameSite: 'lax',
  }));
  assert.equal(hostOnly.url, 'https://chatgpt.com/');
  assert.equal('domain' in hostOnly, false);
  assert.equal('expirationDate' in hostOnly, false);
});

test('SameSite=None cookies must be secure', () => {
  assert.throws(() => buildPackage([
    { environment: sampleEnvironment(), cookies: [sampleCookie({ secure: false })] },
  ]), /必须启用 Secure/);
});

test('cookie fields reject control characters and conflicting host-only domains', () => {
  assert.throws(() => buildPackage([
    { environment: sampleEnvironment(), cookies: [sampleCookie({ name: 'session\nid' })] },
  ]), /包含无效字符/);
  assert.throws(() => buildPackage([
    { environment: sampleEnvironment(), cookies: [sampleCookie({ hostOnly: true })] },
  ]), /host-only Cookie/);
});
