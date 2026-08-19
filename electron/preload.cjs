const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: true,
  closeWindow: () => ipcRenderer.send("window:close"),
  minimizeWindow: () => ipcRenderer.send("window:minimize"),
  toggleAlwaysOnTop: () => ipcRenderer.invoke("window:toggle-always-on-top"),
  // fire-and-forget: toggling recreates the window (and this page with it),
  // so there's no response to wait for — see main.cjs's setGlassMode.
  toggleGlass: () => ipcRenderer.send("window:toggle-glass"),
});
