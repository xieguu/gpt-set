const FORMAT = 'gpt-set-cookie-sessions';
const VERSION = 1;
const LIMITS = Object.freeze({
  fileBytes: 25 * 1024 * 1024,
  environments: 100,
  cookiesPerEnvironment: 5000,
  cookiesTotal: 10000,
  cookieName: 1024,
  cookieValue: 16 * 1024,
  domain: 255,
  path: 2048,
});

const ROOT_KEYS = ['format', 'version', 'exportedAt', 'environments'];
const ENVIRONMENT_KEYS = [
  'name', 'provider', 'baseUrl', 'proxy', 'locale', 'timezone', 'imageBridgeEnabled', 'cookies',
];
const COOKIE_KEYS = [
  'name', 'value', 'domain', 'hostOnly', 'path', 'secure', 'httpOnly', 'session', 'expirationDate', 'sameSite',
];
const SAME_SITES = new Set(['unspecified', 'no_restriction', 'lax', 'strict']);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, allowed, label) {
  if (!isObject(value)) throw new Error(`${label}必须是对象。`);
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown) throw new Error(`${label}包含不支持的字段“${unknown}”。`);
  const missing = allowed.find((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing) throw new Error(`${label}缺少字段“${missing}”。`);
}

function assertString(value, label, maximum, { empty = true } = {}) {
  if (typeof value !== 'string' || value.length > maximum || (!empty && !value.length)) {
    throw new Error(`${label}格式无效。`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label}包含无效字符。`);
}

function validateDomain(value) {
  assertString(value, 'Cookie 域名', LIMITS.domain, { empty: false });
  const host = value.replace(/^\./, '').toLowerCase();
  if (!host || host.endsWith('.') || host.includes('..') || !/^[a-z0-9.-]+$/i.test(host)) {
    throw new Error('Cookie 域名格式无效。');
  }
  if (host.length > 253 || host.split('.').some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) {
    throw new Error('Cookie 域名格式无效。');
  }
  return host;
}

function normalizeSameSite(value) {
  const sameSite = String(value || 'unspecified').toLowerCase();
  if (!SAME_SITES.has(sameSite)) throw new Error('Cookie SameSite 值无效。');
  return sameSite;
}

function serializeCookie(cookie) {
  if (!isObject(cookie)) throw new Error('Cookie 项必须是对象。');
  const domain = String(cookie.domain || '');
  validateDomain(domain);
  if (cookie.hostOnly === true && domain.startsWith('.')) {
    throw new Error('host-only Cookie 的域名不能以“.”开头。');
  }
  const path = String(cookie.path || '/');
  assertString(String(cookie.name ?? ''), 'Cookie 名称', LIMITS.cookieName);
  assertString(String(cookie.value ?? ''), 'Cookie 值', LIMITS.cookieValue);
  assertString(path, 'Cookie 路径', LIMITS.path, { empty: false });
  if (!path.startsWith('/')) throw new Error('Cookie 路径必须以“/”开头。');
  const session = cookie.session === true || !Number.isFinite(cookie.expirationDate);
  const sameSite = normalizeSameSite(cookie.sameSite);
  const secure = Boolean(cookie.secure);
  if (sameSite === 'no_restriction' && !secure) throw new Error('SameSite=None 的 Cookie 必须启用 Secure。');
  return {
    name: String(cookie.name ?? ''), value: String(cookie.value ?? ''), domain,
    hostOnly: Boolean(cookie.hostOnly), path, secure, httpOnly: Boolean(cookie.httpOnly), session,
    expirationDate: session ? null : Number(cookie.expirationDate), sameSite,
  };
}

function validateCookie(cookie) {
  assertExactKeys(cookie, COOKIE_KEYS, 'Cookie 项');
  const serialized = serializeCookie(cookie);
  if (!serialized.session && (!Number.isFinite(serialized.expirationDate) || serialized.expirationDate <= 0)) {
    throw new Error('持久 Cookie 的过期时间无效。');
  }
  if (serialized.session && cookie.expirationDate !== null) throw new Error('会话 Cookie 的过期时间必须为 null。');
  return serialized;
}

function cookieToSetDetails(cookie) {
  const item = validateCookie(cookie);
  const host = validateDomain(item.domain);
  const details = {
    url: `${item.secure ? 'https' : 'http'}://${host}${item.path}`,
    name: item.name, value: item.value, path: item.path, secure: item.secure,
    httpOnly: item.httpOnly, sameSite: item.sameSite,
  };
  if (!item.hostOnly) details.domain = item.domain;
  if (!item.session) details.expirationDate = item.expirationDate;
  return details;
}

function environmentMetadata(environment) {
  return {
    name: String(environment.name || ''), provider: environment.provider === 'custom' ? 'custom' : 'chatgpt',
    baseUrl: String(environment.baseUrl || ''), proxy: String(environment.proxy || ''),
    locale: String(environment.locale || 'zh-CN'), timezone: String(environment.timezone || 'Asia/Shanghai'),
    imageBridgeEnabled: environment.imageBridgeEnabled !== false,
  };
}

function buildPackage(items, now = () => new Date()) {
  if (!Array.isArray(items) || !items.length || items.length > LIMITS.environments) {
    throw new Error(`请选择 1–${LIMITS.environments} 个环境。`);
  }
  let total = 0;
  const packageEnvironments = items.map(({ environment, cookies }) => {
    if (!Array.isArray(cookies) || cookies.length > LIMITS.cookiesPerEnvironment) {
      throw new Error(`单个环境最多导出 ${LIMITS.cookiesPerEnvironment} 个 Cookie。`);
    }
    total += cookies.length;
    if (total > LIMITS.cookiesTotal) throw new Error(`导出包最多包含 ${LIMITS.cookiesTotal} 个 Cookie。`);
    return { ...environmentMetadata(environment), cookies: cookies.map(serializeCookie) };
  });
  return { format: FORMAT, version: VERSION, exportedAt: now().toISOString(), environments: packageEnvironments };
}

function validateEnvironment(item, index) {
  assertExactKeys(item, ENVIRONMENT_KEYS, `第 ${index + 1} 个环境`);
  assertString(item.name, '环境名称', 80, { empty: false });
  if (!['chatgpt', 'custom'].includes(item.provider)) throw new Error('环境服务类型无效。');
  assertString(item.baseUrl, '站点地址', 2048, { empty: false });
  assertString(item.proxy, '代理地址', 2048);
  assertString(item.locale, '语言', 32, { empty: false });
  assertString(item.timezone, '时区', 64, { empty: false });
  if (typeof item.imageBridgeEnabled !== 'boolean') throw new Error('图片桥接设置无效。');
  if (!Array.isArray(item.cookies) || item.cookies.length > LIMITS.cookiesPerEnvironment) {
    throw new Error(`单个环境最多包含 ${LIMITS.cookiesPerEnvironment} 个 Cookie。`);
  }
  return { ...environmentMetadata(item), cookies: item.cookies.map(validateCookie) };
}

function parsePackage(text) {
  if (typeof text !== 'string') throw new Error('登录态文件内容无效。');
  if (Buffer.byteLength(text, 'utf8') > LIMITS.fileBytes) throw new Error('登录态文件过大。');
  let parsed;
  try { parsed = JSON.parse(text.replace(/^﻿/, '')); } catch { throw new Error('登录态文件不是有效的 JSON。'); }
  assertExactKeys(parsed, ROOT_KEYS, '登录态文件');
  if (parsed.format !== FORMAT || parsed.version !== VERSION) throw new Error('不支持的登录态文件格式或版本。');
  if (typeof parsed.exportedAt !== 'string' || Number.isNaN(Date.parse(parsed.exportedAt))) {
    throw new Error('登录态文件的导出时间无效。');
  }
  if (!Array.isArray(parsed.environments) || !parsed.environments.length || parsed.environments.length > LIMITS.environments) {
    throw new Error(`登录态文件必须包含 1–${LIMITS.environments} 个环境。`);
  }
  let total = 0;
  const packageEnvironments = parsed.environments.map((item, index) => {
    const environment = validateEnvironment(item, index);
    total += environment.cookies.length;
    if (total > LIMITS.cookiesTotal) throw new Error(`登录态文件最多包含 ${LIMITS.cookiesTotal} 个 Cookie。`);
    return environment;
  });
  return { format: FORMAT, version: VERSION, exportedAt: new Date(parsed.exportedAt).toISOString(), environments: packageEnvironments };
}

module.exports = {
  FORMAT,
  VERSION,
  LIMITS,
  buildPackage,
  parsePackage,
  serializeCookie,
  cookieToSetDetails,
};
