const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('evalpi', {
  chooseFolder: () => ipcRenderer.invoke('evalpi:choose-folder'),
  openExternal: url => ipcRenderer.invoke('evalpi:open-external', url),
});
