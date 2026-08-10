const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('gptSet', {
  mcpStatus: () => ipcRenderer.invoke('mcp:status'),
  chooseMcpWorkspace: () => ipcRenderer.invoke('mcp:chooseWorkspace'),
  openExtension: () => ipcRenderer.invoke('mcp:openExtension'),
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
});


