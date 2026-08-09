const defaults = { endpoint: 'http://127.0.0.1:8787/bridge/capture', token: 'local-dev-token-change-before-tunnel', enabled: true };
async function config() { return { ...defaults, ...(await chrome.storage.local.get(defaults)) }; }
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'capture') return;
  (async () => {
    const { endpoint, token, enabled } = await config();
    if (!enabled) return { ok: false, skipped: true };
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MCP-Token': token }, body: JSON.stringify(message.payload) });
    return { ok: response.ok, ...(await response.json()) };
  })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
