const { contextBridge, ipcRenderer } = require("electron");

// Read synchronously off this process's own argv (main.cjs passes it via
// webPreferences.additionalArguments) instead of waiting for an IPC message
// after the page loads — a freshly recreated window's page can finish
// loading fast enough to beat a "did-finish-load" listener attached after
// the fact, silently dropping the initial glass-mode state.
const glassModeInitial = process.argv.includes("--glass-mode=1");

contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: true,
  glassModeInitial,
  closeWindow: () => ipcRenderer.send("window:close"),
  minimizeWindow: () => ipcRenderer.send("window:minimize"),
  toggleAlwaysOnTop: () => ipcRenderer.invoke("window:toggle-always-on-top"),
  // fire-and-forget: toggling recreates the window (and this page with it),
  // so there's no response to wait for — see main.cjs's setGlassMode.
  toggleGlass: () => ipcRenderer.send("window:toggle-glass"),
  media: {
    onUpdate: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on("media:update", listener);
      return () => ipcRenderer.removeListener("media:update", listener);
    },
    play: () => ipcRenderer.send("media:play"),
    pause: () => ipcRenderer.send("media:pause"),
    next: () => ipcRenderer.send("media:next"),
    previous: () => ipcRenderer.send("media:previous"),
    setVolume: (level) => ipcRenderer.send("media:set-volume", level),
  },
});
