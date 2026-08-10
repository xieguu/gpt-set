import managedConfig from './managed-config.js';

const endpointInput = document.querySelector('#endpoint');
const tokenInput = document.querySelector('#token');
const enabledInput = document.querySelector('#enabled');
const currentEndpoint = document.querySelector('#currentEndpoint');
const managedState = document.querySelector('#managedState');
const status = document.querySelector('#status');

async function effectiveConfig() {
  if (managedConfig.managed) return { ...managedConfig };
  const stored = await chrome.storage.local.get(['endpoint', 'token', 'enabled']);
  return { ...managedConfig, ...stored };
}

async function render() {
  const config = await effectiveConfig();
  endpointInput.value = config.endpoint;
  tokenInput.value = config.token;
  enabledInput.checked = config.enabled;
  currentEndpoint.textContent = config.endpoint;
  managedState.textContent = config.managed
    ? '由 GPT Set 环境托管；请在主界面修改绑定。'
    : '默认配置，可在下方手动覆盖。';
  for (const input of [endpointInput, tokenInput, enabledInput]) input.disabled = Boolean(config.managed);
  document.querySelector('#save').disabled = Boolean(config.managed);
  document.querySelector('#reset').disabled = Boolean(config.managed);
}

document.querySelector('#save').addEventListener('click', async () => {
  if (managedConfig.managed) return;
  const endpoint = endpointInput.value.trim();
  if (!/^http:\/\/127\.0\.0\.1(?::\d+)?\//.test(endpoint)) {
    status.textContent = '端点必须是 127.0.0.1 本地 HTTP 地址';
    return;
  }

  await chrome.storage.local.set({
    endpoint,
    token: tokenInput.value,
    enabled: enabledInput.checked,
  });
  currentEndpoint.textContent = endpoint;
  status.textContent = '已保存手动配置';
});

document.querySelector('#reset').addEventListener('click', async () => {
  if (managedConfig.managed) return;
  await chrome.storage.local.remove(['endpoint', 'token', 'enabled']);
  await render();
  status.textContent = '已恢复托管默认值';
});

render().catch((error) => {
  status.textContent = `读取配置失败：${error.message}`;
});
