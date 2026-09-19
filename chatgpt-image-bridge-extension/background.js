import managedConfig from './managed-config.js';

const CONFIG_KEYS = ['endpoint', 'token', 'enabled'];
const UPLOAD_TIMEOUT_MS = 20_000;

async function getConfig() {
  if (managedConfig.managed) return { ...managedConfig };
  const stored = await chrome.storage.local.get(CONFIG_KEYS);
  return {
    ...managedConfig,
    ...Object.fromEntries(
      Object.entries(stored).filter(([, value]) => value !== undefined),
    ),
  };
}

async function capture(payload) {
  const { endpoint, token, enabled } = await getConfig();
  if (!enabled) return { ok: false, skipped: true, error: '自动捕获已关闭' };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-MCP-Token': token,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });

  const responseText = await response.text();
  let responseBody = {};
  if (responseText) {
    try {
      responseBody = JSON.parse(responseText);
    } catch {
      responseBody = { message: responseText.slice(0, 500) };
    }
  }

  return {
    ...responseBody,
    ok: response.ok,
    status: response.status,
    retryable: response.status === 408 || response.status === 429 || response.status >= 500,
    error: response.ok
      ? responseBody.error
      : responseBody.error || responseBody.message || `HTTP ${response.status}`,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'config:get') {
    getConfig()
      .then((value) => sendResponse({ ok: true, config: value }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type !== 'capture') return false;

  capture(message.payload)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
