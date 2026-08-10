const list = document.querySelector('#environment-list');
const empty = document.querySelector('#empty');
const dialog = document.querySelector('#environment-dialog');
const form = document.querySelector('#environment-form');
const notice = document.querySelector('#notice');
let environments = [];
let filter = 'active';
let editingId = null;

const formatTime = (value) => value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '从未打开';
function message(text, error = false) { notice.textContent = text; notice.style.color = error ? '#ff9ea8' : '#92e6b1'; }
function field(name) { return form.elements.namedItem(name); }
function render() {
  const shown = environments.filter((env) => Boolean(env.archived) === (filter === 'archived'));
  empty.hidden = shown.length !== 0;
  list.innerHTML = shown.map((env) => `
    <article class="card">
      <h2 title="${escapeHtml(env.name)}">${escapeHtml(env.name)}</h2>
      <p class="url" title="${escapeHtml(env.baseUrl)}">${escapeHtml(env.baseUrl)}</p>
      <div class="meta">最后打开：${formatTime(env.lastOpenedAt)}<br>代理：${env.proxy ? escapeHtml(env.proxy) : '直连'}<br>会话：独立 partition</div>
      <div class="actions">
        <button class="primary" data-action="open" data-id="${env.id}">打开</button>
        <button class="secondary" data-action="edit" data-id="${env.id}">编辑</button>
        <button class="secondary" data-action="copy" data-id="${env.id}">复制</button>
        <button class="secondary" data-action="wipe" data-id="${env.id}">清除会话</button>
        <button class="secondary" data-action="archive" data-id="${env.id}">${env.archived ? '恢复' : '归档'}</button>
        <button class="secondary danger" data-action="delete" data-id="${env.id}">删除</button>
      </div>
    </article>`).join('');
}
function escapeHtml(value) { const node = document.createElement('span'); node.textContent = value || ''; return node.innerHTML; }
async function refreshMcp() { const config = await window.gptSet.mcpStatus(); document.querySelector('#mcp-workspace').textContent = (config.running ? '运行中 · ' : '未启动 · ') + (config.workspaceRoot || '未配置') + ' · ' + config.endpoint; }
async function refresh() { environments = await window.gptSet.list(); render(); }
function openDialog(env) {
  editingId = env?.id || null;
  document.querySelector('#dialog-title').textContent = env ? '编辑环境' : '新建环境';
  field('name').value = env?.name || '';
  field('baseUrl').value = env?.baseUrl || 'https://chatgpt.com/';
  field('provider').value = env?.provider || 'chatgpt';
  field('proxy').value = env?.proxy || '';
  field('locale').value = env?.locale || 'zh-CN';
  field('timezone').value = env?.timezone || 'Asia/Shanghai';
  field('imageBridgeEnabled').checked = env?.imageBridgeEnabled !== false;
  dialog.showModal(); field('name').focus();
}
async function perform(action, id) {
  const env = environments.find((item) => item.id === id);
  try {
    if (action === 'open') { await window.gptSet.open(id); message(`已打开「${env.name}」独立窗口。`); }
    if (action === 'edit') openDialog(env);
    if (action === 'copy') { await window.gptSet.copy(id); await refresh(); message('已复制配置，新环境不包含登录会话。'); }
    if (action === 'archive') { await window.gptSet.setArchived(id, !env.archived); await refresh(); }
    if (action === 'wipe' && confirm(`清除「${env.name}」的全部登录状态、Cookie 和站点数据？`)) { await window.gptSet.wipe(id); message('环境会话已清除。'); }
    if (action === 'delete' && confirm(`彻底删除「${env.name}」及其本地会话数据？`)) { await window.gptSet.remove(id); await refresh(); message('环境已删除。'); }
  } catch (error) { message(error.message || '操作失败。', true); }
}
document.querySelector('#choose-workspace').onclick = async () => { try { const result = await window.gptSet.chooseMcpWorkspace(); if (result) { await refreshMcp(); message(result.restarted ? '工作区已更新，MCP 服务已重启。' : '工作区已写入配置；请重启外部 MCP 服务。'); } } catch (e) { message(e.message, true); } };
document.querySelector('#open-extension').onclick = async () => { await window.gptSet.openExtension(); };
document.querySelector('#add').onclick = () => openDialog();
document.querySelector('#empty-add').onclick = () => openDialog();
document.querySelector('#close-dialog').onclick = () => dialog.close();
document.querySelector('#cancel').onclick = () => dialog.close();
document.querySelector('#import').onclick = async () => { try { const count = await window.gptSet.importConfig(); if (count) { await refresh(); message('已导入 ' + count + ' 个环境，未包含会话数据。'); } } catch (e) { message(e.message, true); } };
document.querySelector('#export').onclick = async () => { try { if (await window.gptSet.exportConfig()) message('配置已导出（不含会话数据）。'); } catch (e) { message(e.message, true); } };
function showEnvironmentView(tab) {
  document.querySelector('#mcp-page').hidden = true;
  document.querySelector('#environment-list').hidden = false;
  document.querySelector('.mcp-panel').hidden = false;
  document.querySelector('#add').hidden = false;
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === tab));
  filter = tab.dataset.filter;
  render();
}
document.querySelectorAll('.tab[data-filter]').forEach((tab) => tab.onclick = () => showEnvironmentView(tab));
async function showMcpPage() {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.id === 'mcp-address'));
  document.querySelector('#environment-list').hidden = true;
  document.querySelector('#empty').hidden = true;
  document.querySelector('.mcp-panel').hidden = true;
  document.querySelector('#add').hidden = true;
  document.querySelector('#mcp-page').hidden = false;
  const config = await window.gptSet.mcpStatus();
  document.querySelector('#mcp-local').value = config.endpoint;
  document.querySelector('#mcp-command').textContent = `cloudflared tunnel --protocol http2 --url http://127.0.0.1:${config.port}`;
  document.querySelector('#mcp-public').value = config.publicAddress || '';
  document.querySelector('#mcp-result').textContent = config.tunnelLogs?.length ? config.tunnelLogs.join('\n') : '尚未启动 Tunnel。';
}
document.querySelector('#mcp-address').onclick = () => showMcpPage().catch((error) => message(error.message, true));
document.querySelector('#run-mcp').onclick = async () => {
  const button = document.querySelector('#run-mcp');
  const output = document.querySelector('#mcp-result');
  button.disabled = true; output.textContent = '正在启动本地 MCP 与 HTTP/2 Tunnel…';
  try {
    const result = await window.gptSet.startMcpTunnel();
    document.querySelector('#mcp-public').value = result.publicAddress;
    output.textContent = result.tunnelLogs.join('\n');
  } catch (error) { output.textContent = `启动失败：${error.message}`; }
  finally { button.disabled = false; }
};
document.querySelector('#copy-mcp').onclick = async () => {
  const address = document.querySelector('#mcp-public').value;
  if (address) { await navigator.clipboard.writeText(address); message('MCP 地址已复制。'); }
};
list.onclick = (event) => { const button = event.target.closest('button[data-action]'); if (button) perform(button.dataset.action, button.dataset.id); };
form.onsubmit = async (event) => { event.preventDefault(); const data = Object.fromEntries(new FormData(form)); try { if (editingId) await window.gptSet.update(editingId, data); else await window.gptSet.create(data); dialog.close(); await refresh(); message(editingId ? '环境已更新。' : '环境已创建。'); } catch (error) { message(error.message || '保存失败。', true); } };
Promise.all([refresh(), refreshMcp()]).catch((error) => message(error.message, true));





