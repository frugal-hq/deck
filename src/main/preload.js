const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deck', {
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  start: (options) => ipcRenderer.invoke('chat:start', options),
  input: (id, data) => ipcRenderer.send('chat:input', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('chat:resize', id, cols, rows),
  kill: (id) => ipcRenderer.send('chat:kill', id),
  onData: (callback) => ipcRenderer.on('chat:data', (_, id, data) => callback(id, data)),
  onExit: (callback) => ipcRenderer.on('chat:exit', (_, id, code) => callback(id, code)),
  onMeters: (callback) => ipcRenderer.on('chat:meters', (_, id, meters) => callback(id, meters)),
  getSessions: () => ipcRenderer.invoke('sessions:get'),
  getAllSessions: () => ipcRenderer.invoke('sessions:all'),
  organize: (id, organization) => ipcRenderer.send('sessions:organize', id, organization),
  onSessions: (callback) => ipcRenderer.on('sessions:changed', (_, index) => callback(index)),
});
