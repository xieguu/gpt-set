const environmentList = document.querySelector('#environment-list');
const environmentEmpty = document.querySelector('#empty');
const environmentDialog = document.querySelector('#environment-dialog');
const environmentForm = document.querySelector('#environment-form');
const mcpPage = document.querySelector('#mcp-page');
const mcpList = document.querySelector('#mcp-instance-list');
const mcpEmpty = document.querySelector('#mcp-empty');
const mcpDialog = document.querySelector('#mcp-dialog');
const mcpForm = document.querySelector('#mcp-form');
const notice = document.querySelector('#notice');

let environments = [];
let mcpInstances = [];
let filter = 'active';
let currentView = 'environments';
let editingEnvironmentId = null;
let editingMcpId = null;
const busyInstances = new Set();
let mcpRefreshInFlight = null;
let environmentRenderSignature = '';
let mcpRenderSignature = '';
let mcpOptionsSignature = '';
const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });

const formatTime = (value) => {
  if (!value) return '从未打开';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未知';
  return dateTimeFormatter.format(date);
};

function escapeHtml(value) {
  const node = document.createElement('span');
  node.textContent = String(value ?? '');
  return node.innerHTML;
}

function errorText(error, fallback = '操作失败。') {
  return error?.message || String(error || fallback);
}

function message(text, error = false) {
  notice.textContent = String(text || '');
  notice.classList.toggle('error', error);
}

function environmentField(name) {
  return environmentForm.elements.namedItem(name);
}

function mcpField(name) {
  return mcpForm.elements.namedItem(name);
}

function getMcpInstance(id) {
  return mcpInstances.find((item) => String(item.id) === String(id));
}

function mcpEndpoint(instance) {
  return instance.endpoint || `http://127.0.0.1:${instance.port}/mcp`;
}

function tunnelAddress(instance) {
  return instance.tunnel?.publicAddress || instance.publicAddress || '';
}

function logText(logs, emptyText) {
  if (Array.isArray(logs)) return logs.length ? logs.join('\n') : emptyText;
  return logs ? String(logs) : emptyText;
}

function renderEnvironments() {
  const shown = environments.filter((env) => Boolean(env.archived) === (filter === 'archived'));
  const signature = JSON.stringify([
    currentView,
    filter,
    shown,
    mcpInstances.map((instance) => [instance.id, instance.name, instance.running, instance.port]),
  ]);
  if (signature === environmentRenderSignature) return;
  environmentRenderSignature = signature;
  environmentEmpty.hidden = currentView !== 'environments' || shown.length !== 0;
  environmentList.innerHTML = shown.map((env) => {
    const boundMcp = env.mcpInstanceId ? getMcpInstance(env.mcpInstanceId) : null;
    const mcpDescription = boundMcp
      ? `${boundMcp.name} · ${boundMcp.running ? '运行中' : '已停止'} · ${mcpEndpoint(boundMcp)}`
      : env.mcpInstanceId ? '绑定的 MCP 实例已不存在' : '未绑定';
    return `
      <article class="card">
        <h2 title="${escapeHtml(env.name)}">${escapeHtml(env.name)}</h2>
        <p class="url" title="${escapeHtml(env.baseUrl)}">${escapeHtml(env.baseUrl)}</p>
        <div class="meta">
          最后打开：${escapeHtml(formatTime(env.lastOpenedAt))}<br>
          代理：${env.proxy ? escapeHtml(env.proxy) : '跟随系统'}<br>
          MCP：<span title="${escapeHtml(mcpDescription)}">${escapeHtml(boundMcp?.name || (env.mcpInstanceId ? '绑定失效' : '未绑定'))}</span><br>
          会话：独立 partition
        </div>
        <div class="actions">
          <button class="primary" data-action="open" data-id="${escapeHtml(env.id)}">打开</button>
          <button class="secondary" data-action="edit" data-id="${escapeHtml(env.id)}">编辑</button>
          <button class="secondary" data-action="copy" data-id="${escapeHtml(env.id)}">复制</button>
          <button class="secondary" data-action="wipe" data-id="${escapeHtml(env.id)}">清除会话</button>
          <button class="secondary" data-action="archive" data-id="${escapeHtml(env.id)}">${env.archived ? '恢复' : '归档'}</button>
          <button class="secondary danger" data-action="delete" data-id="${escapeHtml(env.id)}">删除</button>
        </div>
      </article>`;
  }).join('');
}

function mcpState(instance) {
  if (instance.error) return { label: '异常', className: 'error' };
  if (instance.running) return { label: '运行中', className: 'running' };
  if (['starting', 'stopping', 'restarting'].includes(instance.state)) {
    return { label: instance.state === 'starting' ? '启动中' : instance.state === 'stopping' ? '停止中' : '重启中', className: 'pending' };
  }
  return { label: '已停止', className: 'stopped' };
}

function renderMcpInstances() {
  const signature = JSON.stringify([mcpInstances, [...busyInstances].sort()]);
  if (signature === mcpRenderSignature) return;
  mcpRenderSignature = signature;
  const runningCount = mcpInstances.filter((item) => item.running).length;
  document.querySelector('#mcp-summary').textContent = `${runningCount} 个运行中 / 共 ${mcpInstances.length} 个实例`;
  document.querySelector('#mcp-page-summary').textContent = `${runningCount} 个运行中 / 共 ${mcpInstances.length} 个实例；每个实例拥有独立目录、端口、Token 和 Tunnel。`;
  mcpEmpty.hidden = mcpInstances.length !== 0;
  mcpList.innerHTML = mcpInstances.map((instance) => {
    const state = mcpState(instance);
    const tunnelRunning = Boolean(instance.tunnel?.running);
    const publicAddress = tunnelAddress(instance);
    const busy = busyInstances.has(String(instance.id));
    const disabled = busy ? ' disabled' : '';
    const serviceLogs = logText(instance.logs, '暂无服务日志。');
    const tunnelLogs = logText(instance.tunnel?.logs, '暂无 Tunnel 日志。');
    return `
      <article class="mcp-card${busy ? ' busy' : ''}">
        <div class="mcp-card-head">
          <div class="mcp-title-row">
            <h3 title="${escapeHtml(instance.name)}">${escapeHtml(instance.name)}</h3>
            <span class="state ${state.className}">${state.label}</span>
            ${tunnelRunning ? '<span class="state tunnel">Tunnel</span>' : ''}
          </div>
          <div class="mcp-card-tools">
            <button class="secondary small" data-mcp-action="edit" data-id="${escapeHtml(instance.id)}"${disabled}>编辑</button>
            <button class="secondary small" data-mcp-action="choose-workspace" data-id="${escapeHtml(instance.id)}"${disabled}>选择目录</button>
          </div>
        </div>

        <dl class="mcp-meta">
          <div><dt>端口</dt><dd>${escapeHtml(instance.port)}</dd></div>
          <div><dt>PID</dt><dd>${escapeHtml(instance.pid || '—')}</dd></div>
          <div><dt>自动启动</dt><dd>${instance.autoStart ? '是' : '否'}</dd></div>
          <div class="wide"><dt>工作目录</dt><dd title="${escapeHtml(instance.workspaceRoot)}">${escapeHtml(instance.workspaceRoot || '未配置')}</dd></div>
        </dl>

        <div class="address-block">
          <span>本地地址</span>
          <div class="address-row">
            <code title="${escapeHtml(mcpEndpoint(instance))}">${escapeHtml(mcpEndpoint(instance))}</code>
            <button class="secondary small" data-mcp-action="copy-local" data-id="${escapeHtml(instance.id)}"${disabled}>复制</button>
          </div>
        </div>
        <div class="address-block">
          <span>公网地址</span>
          <div class="address-row">
            <code class="${publicAddress ? '' : 'muted'}" title="${escapeHtml(publicAddress)}">${escapeHtml(publicAddress || '启动 Tunnel 后显示')}</code>
            <button class="secondary small" data-mcp-action="copy-public" data-id="${escapeHtml(instance.id)}"${publicAddress && !busy ? '' : ' disabled'}>复制</button>
          </div>
        </div>

        ${instance.error ? `<p class="inline-error">服务：${escapeHtml(instance.error)}</p>` : ''}
        ${instance.tunnel?.error ? `<p class="inline-error">Tunnel：${escapeHtml(instance.tunnel.error)}</p>` : ''}

        <div class="mcp-controls">
          <button class="primary" data-mcp-action="start" data-id="${escapeHtml(instance.id)}"${instance.running || instance.pid || busy ? ' disabled' : ''}>启动</button>
          <button class="secondary" data-mcp-action="stop" data-id="${escapeHtml(instance.id)}"${(!instance.running && !instance.pid) || busy ? ' disabled' : ''}>停止</button>
          <button class="secondary" data-mcp-action="restart" data-id="${escapeHtml(instance.id)}"${busy ? ' disabled' : ''}>重启</button>
          <button class="secondary" data-mcp-action="${tunnelRunning ? 'stop-tunnel' : 'start-tunnel'}" data-id="${escapeHtml(instance.id)}"${disabled}>${tunnelRunning ? '停止 Tunnel' : '启动 Tunnel'}</button>
          <button class="secondary" data-mcp-action="rotate-token" data-id="${escapeHtml(instance.id)}"${disabled}>轮换 Token</button>
          <button class="secondary danger" data-mcp-action="delete" data-id="${escapeHtml(instance.id)}"${disabled}>删除</button>
        </div>

        <details class="logs">
          <summary>服务日志</summary>
          <pre>${escapeHtml(serviceLogs)}</pre>
        </details>
        <details class="logs">
          <summary>Tunnel 日志</summary>
          <pre>${escapeHtml(tunnelLogs)}</pre>
        </details>
      </article>`;
  }).join('');
}

function populateMcpOptions(selectedValue) {
  const select = environmentField('mcpInstanceId');
  const current = selectedValue !== undefined ? String(selectedValue || '') : select.value;
  const signature = JSON.stringify([
    current,
    mcpInstances.map((instance) => [instance.id, instance.name, instance.running, instance.port]),
  ]);
  if (signature === mcpOptionsSignature) return;
  mcpOptionsSignature = signature;
  select.innerHTML = '<option value="">默认 MCP 实例（自动）</option>' + mcpInstances.map((instance) =>
    `<option value="${escapeHtml(instance.id)}">${escapeHtml(instance.name)} · ${instance.running ? '运行中' : '已停止'} · :${escapeHtml(instance.port)}</option>`
  ).join('');
  select.value = mcpInstances.some((item) => String(item.id) === current) ? current : '';
}

async function refreshEnvironments() {
  const result = await window.gptSet.list();
  environments = Array.isArray(result) ? result : [];
  renderEnvironments();
}

async function refreshMcpInstances({ quiet = false } = {}) {
  if (mcpRefreshInFlight) return mcpRefreshInFlight;
  mcpRefreshInFlight = (async () => {
    try {
      const result = await window.gptSet.listMcpInstances();
      mcpInstances = Array.isArray(result) ? result : [];
      populateMcpOptions();
      renderMcpInstances();
      renderEnvironments();
    } catch (error) {
      if (!quiet) throw error;
    }
  })().finally(() => { mcpRefreshInFlight = null; });
  return mcpRefreshInFlight;
}

async function refreshAll() {
  await Promise.all([refreshEnvironments(), refreshMcpInstances()]);
}

function openEnvironmentDialog(env) {
  editingEnvironmentId = env?.id || null;
  document.querySelector('#dialog-title').textContent = env ? '编辑环境' : '新建环境';
  environmentField('name').value = env?.name || '';
  environmentField('baseUrl').value = env?.baseUrl || 'https://chatgpt.com/';
  environmentField('provider').value = env?.provider || 'chatgpt';
  environmentField('proxy').value = env?.proxy || '';
  environmentField('locale').value = env?.locale || 'zh-CN';
  environmentField('timezone').value = env?.timezone || 'Asia/Shanghai';
  environmentField('imageBridgeEnabled').checked = env?.imageBridgeEnabled !== false;
  populateMcpOptions(env?.mcpInstanceId || '');
  environmentDialog.showModal();
  environmentField('name').focus();
}

async function performEnvironmentAction(action, id) {
  const env = environments.find((item) => String(item.id) === String(id));
  if (!env) return message('环境不存在，请刷新后重试。', true);
  try {
    if (action === 'open') {
      const result = await window.gptSet.open(id);
      await refreshEnvironments();
      message(result?.loadError ? `「${env.name}」窗口已创建，但页面加载失败：${result.loadError}` : `已打开「${env.name}」独立窗口。`, Boolean(result?.loadError));
    } else if (action === 'edit') {
      openEnvironmentDialog(env);
    } else if (action === 'copy') {
      await window.gptSet.copy(id);
      await refreshEnvironments();
      message('已复制配置，新环境不包含登录会话。');
    } else if (action === 'archive') {
      await window.gptSet.setArchived(id, !env.archived);
      await refreshEnvironments();
    } else if (action === 'wipe' && confirm(`清除「${env.name}」的全部登录状态、Cookie 和站点数据？`)) {
      await window.gptSet.wipe(id);
      message('环境会话已清除。');
    } else if (action === 'delete' && confirm(`彻底删除「${env.name}」及其本地会话数据？`)) {
      await window.gptSet.remove(id);
      await refreshEnvironments();
      message('环境已删除。');
    }
  } catch (error) {
    await refreshMcpInstances({ quiet: true });
    message(errorText(error), true);
  }
}

function editableMcpPayload(instance, overrides = {}) {
  return {
    name: overrides.name ?? instance.name,
    workspaceRoot: overrides.workspaceRoot ?? instance.workspaceRoot,
    port: Number(overrides.port ?? instance.port),
    autoStart: overrides.autoStart ?? Boolean(instance.autoStart),
  };
}

function selectedWorkspace(result) {
  if (!result) return '';
  if (typeof result === 'string') return result;
  return result.workspaceRoot || result.path || result.filePath || '';
}

function selectedPort(result) {
  const port = Number(typeof result === 'object' && result ? result.port : result);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 0;
}

async function openMcpDialog(instance = null) {
  editingMcpId = instance?.id || null;
  mcpForm.reset();
  document.querySelector('#mcp-dialog-title').textContent = instance ? '编辑 MCP 实例' : '新增 MCP 实例';
  document.querySelector('#mcp-form-error').textContent = '';
  mcpField('name').value = instance?.name || '';
  mcpField('workspaceRoot').value = instance?.workspaceRoot || '';
  mcpField('port').value = instance?.port || 8787;
  mcpField('autoStart').checked = Boolean(instance?.autoStart);
  mcpDialog.showModal();
  mcpField('name').focus();
  if (!instance) {
    try {
      const result = await window.gptSet.findMcpPort(8787);
      const port = selectedPort(result);
      if (port && mcpDialog.open && !editingMcpId) mcpField('port').value = port;
    } catch {
      // 保留默认端口，提交时由主进程再次校验。
    }
  }
}

async function copyText(text) {
  if (!text) throw new Error('当前没有可复制的地址。');
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) throw new Error('复制失败。');
  }
}

async function performMcpAction(action, id) {
  const instance = getMcpInstance(id);
  if (!instance) return message('MCP 实例不存在，请刷新后重试。', true);
  if (action === 'edit') return openMcpDialog(instance);
  if (action === 'copy-local' || action === 'copy-public') {
    try {
      await copyText(action === 'copy-local' ? mcpEndpoint(instance) : tunnelAddress(instance));
      message(action === 'copy-local' ? '本地 MCP 地址已复制。' : '公网 MCP 地址已复制。');
    } catch (error) {
      message(errorText(error), true);
    }
    return;
  }
  if (action === 'delete' && !confirm(`删除 MCP 实例「${instance.name}」？运行中的服务和 Tunnel 会一并停止。`)) return;
  if (action === 'rotate-token' && !confirm(`轮换「${instance.name}」的 Token？旧的公网 MCP 地址会立即失效。`)) return;

  busyInstances.add(String(id));
  renderMcpInstances();
  try {
    if (action === 'start') await window.gptSet.startMcpInstance(id);
    else if (action === 'stop') await window.gptSet.stopMcpInstance(id);
    else if (action === 'restart') await window.gptSet.restartMcpInstance(id);
    else if (action === 'start-tunnel') await window.gptSet.startMcpTunnel(id);
    else if (action === 'stop-tunnel') await window.gptSet.stopMcpTunnel(id);
    else if (action === 'rotate-token') await window.gptSet.rotateMcpToken(id);
    else if (action === 'delete') await window.gptSet.deleteMcpInstance(id);
    else if (action === 'choose-workspace') {
      const picked = selectedWorkspace(await window.gptSet.pickMcpWorkspace(instance.workspaceRoot));
      if (!picked) return;
      await window.gptSet.updateMcpInstance(id, editableMcpPayload(instance, { workspaceRoot: picked }));
    }
    await refreshMcpInstances();
    if (action === 'delete') await refreshEnvironments();
    message(`MCP 实例「${instance.name}」操作完成。`);
  } catch (error) {
    await refreshMcpInstances({ quiet: true });
    message(errorText(error), true);
  } finally {
    busyInstances.delete(String(id));
    renderMcpInstances();
  }
}

function showEnvironmentView(tab) {
  currentView = 'environments';
  mcpPage.hidden = true;
  environmentList.hidden = false;
  document.querySelector('.mcp-panel').hidden = false;
  document.querySelector('#add').hidden = false;
  document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item === tab));
  filter = tab.dataset.filter;
  renderEnvironments();
}

async function showMcpPage() {
  currentView = 'mcp';
  document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item.id === 'mcp-address'));
  environmentList.hidden = true;
  environmentEmpty.hidden = true;
  document.querySelector('.mcp-panel').hidden = true;
  document.querySelector('#add').hidden = true;
  mcpPage.hidden = false;
  await refreshMcpInstances();
}

async function performAllMcp(action) {
  const startButton = document.querySelector('#start-all-mcp');
  const stopButton = document.querySelector('#stop-all-mcp');
  startButton.disabled = true;
  stopButton.disabled = true;
  try {
    if (action === 'start') await window.gptSet.startAllMcp();
    else await window.gptSet.stopAllMcp();
    await refreshMcpInstances();
    message(action === 'start' ? '全部 MCP 实例已启动。' : '全部 MCP 实例已停止。');
  } catch (error) {
    await refreshMcpInstances({ quiet: true });
    message(errorText(error), true);
  } finally {
    startButton.disabled = false;
    stopButton.disabled = false;
  }
}

document.querySelector('#add').onclick = () => openEnvironmentDialog();
document.querySelector('#empty-add').onclick = () => openEnvironmentDialog();
document.querySelector('#close-dialog').onclick = () => environmentDialog.close();
document.querySelector('#cancel').onclick = () => environmentDialog.close();
document.querySelector('#close-mcp-dialog').onclick = () => mcpDialog.close();
document.querySelector('#cancel-mcp').onclick = () => mcpDialog.close();

document.querySelector('#import').onclick = async () => {
  try {
    const count = await window.gptSet.importConfig();
    if (count) {
      await refreshEnvironments();
      message(`已导入 ${count} 个环境，未包含会话数据。`);
    }
  } catch (error) {
    message(errorText(error), true);
  }
};

document.querySelector('#export').onclick = async () => {
  try {
    if (await window.gptSet.exportConfig()) message('配置已导出（不含会话数据）。');
  } catch (error) {
    message(errorText(error), true);
  }
};

document.querySelector('#open-extension').onclick = async () => {
  try {
    await window.gptSet.openExtension();
  } catch (error) {
    message(errorText(error), true);
  }
};

document.querySelectorAll('.tab[data-filter]').forEach((tab) => {
  tab.onclick = () => showEnvironmentView(tab);
});
document.querySelector('#mcp-address').onclick = () => showMcpPage().catch((error) => message(errorText(error), true));
document.querySelector('#manage-mcp').onclick = () => showMcpPage().catch((error) => message(errorText(error), true));
document.querySelector('#add-mcp').onclick = () => openMcpDialog();
document.querySelector('#empty-add-mcp').onclick = () => openMcpDialog();
document.querySelector('#start-all-mcp').onclick = () => performAllMcp('start');
document.querySelector('#stop-all-mcp').onclick = () => performAllMcp('stop');

environmentList.onclick = (event) => {
  const button = event.target.closest('button[data-action]');
  if (button) performEnvironmentAction(button.dataset.action, button.dataset.id);
};

mcpList.onclick = (event) => {
  const button = event.target.closest('button[data-mcp-action]');
  if (button && !button.disabled) performMcpAction(button.dataset.mcpAction, button.dataset.id);
};

document.querySelector('#pick-mcp-workspace').onclick = async () => {
  try {
    const picked = selectedWorkspace(await window.gptSet.pickMcpWorkspace(mcpField('workspaceRoot').value));
    if (picked) mcpField('workspaceRoot').value = picked;
  } catch (error) {
    document.querySelector('#mcp-form-error').textContent = errorText(error);
  }
};

document.querySelector('#find-mcp-port').onclick = async () => {
  const button = document.querySelector('#find-mcp-port');
  button.disabled = true;
  try {
    const port = selectedPort(await window.gptSet.findMcpPort(Number(mcpField('port').value) || 8787));
    if (!port) throw new Error('没有找到可用端口。');
    mcpField('port').value = port;
    document.querySelector('#mcp-form-error').textContent = '';
  } catch (error) {
    document.querySelector('#mcp-form-error').textContent = errorText(error);
  } finally {
    button.disabled = false;
  }
};

environmentForm.onsubmit = async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(environmentForm));
  data.imageBridgeEnabled = environmentField('imageBridgeEnabled').checked;
  data.mcpInstanceId = environmentField('mcpInstanceId').value || '';
  const id = editingEnvironmentId;
  try {
    if (id) await window.gptSet.update(id, data);
    else await window.gptSet.create(data);
    environmentDialog.close();
    editingEnvironmentId = null;
    await refreshEnvironments();
    message(id ? '环境已更新。' : '环境已创建。');
  } catch (error) {
    message(errorText(error, '保存失败。'), true);
  }
};

mcpForm.onsubmit = async (event) => {
  event.preventDefault();
  const errorNode = document.querySelector('#mcp-form-error');
  const port = Number(mcpField('port').value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    errorNode.textContent = '端口必须是 1024–65535 之间的整数。';
    return;
  }
  const data = {
    name: mcpField('name').value.trim(),
    workspaceRoot: mcpField('workspaceRoot').value.trim(),
    port,
    autoStart: mcpField('autoStart').checked,
  };
  const id = editingMcpId;
  const submitButton = mcpForm.querySelector('button[value="default"]');
  submitButton.disabled = true;
  errorNode.textContent = '';
  try {
    if (id) await window.gptSet.updateMcpInstance(id, data);
    else await window.gptSet.createMcpInstance(data);
    mcpDialog.close();
    editingMcpId = null;
    await refreshMcpInstances();
    message(id ? 'MCP 实例已更新。' : 'MCP 实例已创建。');
  } catch (error) {
    errorNode.textContent = errorText(error, '保存失败。');
  } finally {
    submitButton.disabled = false;
  }
};

refreshAll().catch((error) => message(errorText(error), true));

setInterval(() => {
  if (!document.hidden) {
    refreshMcpInstances({ quiet: true });
  }
}, 3000);
