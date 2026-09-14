const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gptSet', {
  // MCP 多实例管理
  listMcpInstances: () => ipcRenderer.invoke('mcp:list'),
  createMcpInstance: (input) => ipcRenderer.invoke('mcp:create', input),
  updateMcpInstance: (id, input) => ipcRenderer.invoke('mcp:update', id, input),
  deleteMcpInstance: (id) => ipcRenderer.invoke('mcp:delete', id),
  pickMcpWorkspace: (defaultPath) => ipcRenderer.invoke('mcp:pickWorkspace', defaultPath),
  findMcpPort: (preferred) => ipcRenderer.invoke('mcp:findPort', preferred),
  startMcpInstance: (id) => ipcRenderer.invoke('mcp:start', id),
  stopMcpInstance: (id) => ipcRenderer.invoke('mcp:stop', id),
  restartMcpInstance: (id) => ipcRenderer.invoke('mcp:restart', id),
  startMcpTunnel: (id) => ipcRenderer.invoke('mcp:startTunnel', id),
  stopMcpTunnel: (id) => ipcRenderer.invoke('mcp:stopTunnel', id),
  startAllMcp: () => ipcRenderer.invoke('mcp:startAll'),
  stopAllMcp: () => ipcRenderer.invoke('mcp:stopAll'),
  rotateMcpToken: (id) => ipcRenderer.invoke('mcp:rotateToken', id),
  openExtension: () => ipcRenderer.invoke('mcp:openExtension'),

  // 浏览器环境管理
  list: () => ipcRenderer.invoke('environments:list'),
  create: (input) => ipcRenderer.invoke('environments:create', input),
  update: (id, input) => ipcRenderer.invoke('environments:update', id, input),
  copy: (id) => ipcRenderer.invoke('environments:copy', id),
  setArchived: (id, archived) => ipcRenderer.invoke('environments:setArchived', id, archived),
  open: (id) => ipcRenderer.invoke('environments:open', id),
  wipe: (id) => ipcRenderer.invoke('environments:wipe', id),
  remove: (id) => ipcRenderer.invoke('environments:delete', id),
  importConfig: () => ipcRenderer.invoke('environments:import'),
  exportConfig: () => ipcRenderer.invoke('environments:export'),
  importSessions: () => ipcRenderer.invoke('environments:importSessions'),
  exportSessions: () => ipcRenderer.invoke('environments:exportSessions'),
});
