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
document.querySelector('#add').onclick = () => openDialog();
document.querySelector('#empty-add').onclick = () => openDialog();
document.querySelector('#close-dialog').onclick = () => dialog.close();
document.querySelector('#cancel').onclick = () => dialog.close();
document.querySelector('#import').onclick = async () => { try { const count = await window.gptSet.importConfig(); if (count) { await refresh(); message('已导入 ' + count + ' 个环境，未包含会话数据。'); } } catch (e) { message(e.message, true); } };
document.querySelector('#export').onclick = async () => { try { if (await window.gptSet.exportConfig()) message('配置已导出（不含会话数据）。'); } catch (e) { message(e.message, true); } };
document.querySelectorAll('.tab').forEach((tab) => tab.onclick = () => { filter = tab.dataset.filter; document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === tab)); render(); });
list.onclick = (event) => { const button = event.target.closest('button[data-action]'); if (button) perform(button.dataset.action, button.dataset.id); };
form.onsubmit = async (event) => { event.preventDefault(); const data = Object.fromEntries(new FormData(form)); try { if (editingId) await window.gptSet.update(editingId, data); else await window.gptSet.create(data); dialog.close(); await refresh(); message(editingId ? '环境已更新。' : '环境已创建。'); } catch (error) { message(error.message || '保存失败。', true); } };
refresh().catch((error) => message(error.message, true));


