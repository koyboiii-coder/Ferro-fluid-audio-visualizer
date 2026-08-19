const { app, BrowserWindow, Tray, Menu, ipcMain, session, desktopCapturer, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const {
  sendMediaCommand,
  startMediaPolling,
  pollVolume,
  setMediaVolume,
  stopVolumeProcess,
  stopMediaProcess,
} = require("./media-session.cjs");

// Temporary diagnostic log (not shipped logic, just visibility into the
// "Sistema" audio capture failing after the Electron 33->43 upgrade, which
// can't be reproduced/debugged from outside a real desktop session).
const debugLogPath = path.join(app.getPath("userData"), "debug.log");
function debugLog(...args) {
  try {
    const line = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`;
    fs.appendFileSync(debugLogPath, line);
  } catch (err) {
    // no-op: logging must never crash the app
  }
}
process.on("uncaughtException", (err) => debugLog("uncaughtException", err.stack || err.message));

let mainWindow = null;
let tray = null;
let alwaysOnTop = true;
let isQuitting = false;
let glassMode = false;
let lastMediaState = { active: false };
let cachedVolume = null;

const iconPath = path.join(__dirname, "icon.png");

// `transparent`/`backgroundMaterial` only reliably take effect when set at
// BrowserWindow construction time on Windows — flipping them on a live
// window via the setter methods compiles and runs without error, but the
// compositor never actually re-treats the page as see-through. So toggling
// glass mode recreates the window from scratch with the right options baked
// in, instead of mutating the existing one.
function createWindow(bounds) {
  const wasVisible = mainWindow != null;
  const glass = glassMode;
  mainWindow = new BrowserWindow({
    width: 520,
    height: 660,
    minWidth: 400,
    minHeight: 420,
    ...bounds,
    frame: false,
    alwaysOnTop,
    show: !wasVisible, // avoid a visible flash of the un-styled window when swapping
    transparent: true,
    backgroundColor: glass ? "#00000000" : "#0a0a0f",
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // Deterministically tell the fresh page whether glass mode is on
      // *before* its own JS runs, instead of racing a "did-finish-load"
      // listener attached after loadURL/loadFile already fired (a local
      // asar-packed page can finish loading fast enough to win that race).
      additionalArguments: [`--glass-mode=${glass ? "1" : "0"}`],
    },
  });
  // The `backgroundColor` constructor option was silently not taking effect
  // on this Electron/Windows combination — getBackgroundColor() came back
  // as the Electron default #FFFFFF (opaque white) regardless of what was
  // passed in, which is exactly the plain white flash seen on toggle. Same
  // deal for backgroundMaterial. Both get set again explicitly right after
  // construction, before the window is ever shown, as the path that
  // actually sticks.
  mainWindow.setBackgroundColor(glass ? "#00000000" : "#0a0a0f");
  if (process.platform === "win32") {
    try {
      mainWindow.setBackgroundMaterial(glass ? "acrylic" : "none");
    } catch (err) {
      debugLog("setBackgroundMaterial failed", err.message);
    }
  }
  debugLog("createWindow", {
    glass,
    platform: process.platform,
    backgroundColor: mainWindow.getBackgroundColor(),
  });
  // Glass-mode toggle recreates the whole window/page, so re-push whatever
  // now-playing state is already known instead of leaving the fresh page
  // waiting on the next poll tick to notice a change (which may not come
  // for a while if the same track just keeps playing).
  mainWindow.webContents.on("did-finish-load", () => mainWindow.webContents.send("media:update", lastMediaState));
  mainWindow.webContents.on("render-process-gone", (_e, details) => debugLog("render-process-gone", details));
  mainWindow.on("unresponsive", () => debugLog("window unresponsive"));
  mainWindow.once("ready-to-show", () => {
    if (wasVisible) mainWindow.show();
  });

  if (app.isPackaged) {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  } else {
    mainWindow.loadURL("http://localhost:5173");
  }

  // Keep the window (and its live audio connection) alive in the background
  // instead of destroying it — closing just hides it, like a real widget.
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function setGlassMode(enabled) {
  glassMode = enabled;
  debugLog("setGlassMode", enabled);
  if (!mainWindow) return;
  const bounds = mainWindow.getBounds();
  const wasAlwaysOnTop = mainWindow.isAlwaysOnTop();
  mainWindow.removeAllListeners("close");
  mainWindow.destroy();
  createWindow(bounds);
  mainWindow.setAlwaysOnTop(wasAlwaysOnTop);
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

function createTray() {
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip("Nikkiro Audio Visualizer");

  const rebuildMenu = () => {
    const menu = Menu.buildFromTemplate([
      { label: "Mostrar", click: showWindow },
      {
        label: "Siempre encima",
        type: "checkbox",
        checked: alwaysOnTop,
        click: (item) => {
          alwaysOnTop = item.checked;
          mainWindow?.setAlwaysOnTop(alwaysOnTop);
        },
      },
      {
        label: "Iniciar con Windows",
        type: "checkbox",
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
      },
      { type: "separator" },
      {
        label: "Salir",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(menu);
  };

  rebuildMenu();
  tray.on("click", showWindow);
}

app.whenReady().then(() => {
  // Auto-grant mic/display-capture permission checks (there's no browser
  // permission-bar UI in a frameless Electron window to click "Allow" on).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "media");
  });

  // Skip the picker entirely: grab the primary screen's audio loopback the
  // instant "Sistema" is clicked, so the widget just works with no dialog.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    debugLog("setDisplayMediaRequestHandler: request received");
    desktopCapturer
      .getSources({ types: ["screen"] })
      .then((sources) => {
        debugLog(
          "desktopCapturer sources",
          sources.map((s) => ({ id: s.id, name: s.name, displayId: s.display_id }))
        );
        if (sources.length === 0) {
          debugLog("no screen sources available, calling back with empty streams");
          callback({});
          return;
        }
        debugLog("granting video source", sources[0].id, sources[0].name);
        callback({ video: sources[0], audio: "loopback" });
      })
      .catch((err) => {
        debugLog("desktopCapturer.getSources failed", err.stack || err.message);
        callback({});
      });
  });

  createWindow();
  createTray();

  // Now-playing bar: polls Windows' SMTC (System Media Transport Controls)
  // and pushes updates to whichever window currently exists (mainWindow is
  // reassigned wholesale on glass-mode toggle, so this closure always reads
  // the live reference rather than a stale one captured at startup).
  //
  // System master volume rides along in the same payload, but is only
  // actually re-read from Core Audio every ~15s (not every SMTC tick):
  // unlike the WinRT calls above, reading it compiles a small C# helper via
  // Add-Type on each call, which is real overhead to pay every 2s
  // indefinitely while Spotify is open. The ring's own drag/keyboard
  // interaction already updates this value immediately when the user
  // changes it — the periodic read is only a slow safety-net resync for
  // volume changed elsewhere (keyboard media keys, the system tray, etc.).
  let lastVolumeFetch = 0;
  startMediaPolling((state) => {
    lastMediaState = { ...state, volume: cachedVolume };
    mainWindow?.webContents.send("media:update", lastMediaState);
    if (state.active && Date.now() - lastVolumeFetch > 15000) {
      lastVolumeFetch = Date.now();
      pollVolume()
        .then((volume) => {
          cachedVolume = volume;
          lastMediaState = { ...lastMediaState, volume };
          mainWindow?.webContents.send("media:update", lastMediaState);
        })
        .catch((err) => debugLog("pollVolume failed", err.message));
    }
  });

  app.on("activate", showWindow);
});

app.on("before-quit", () => {
  isQuitting = true;
  stopVolumeProcess();
  stopMediaProcess();
});

app.on("window-all-closed", () => {
  // no-op: the app lives in the tray until "Salir" is chosen
});

ipcMain.on("window:close", () => mainWindow?.close());
ipcMain.on("window:minimize", () => mainWindow?.minimize());
ipcMain.handle("window:toggle-always-on-top", () => {
  alwaysOnTop = !alwaysOnTop;
  mainWindow?.setAlwaysOnTop(alwaysOnTop);
  return alwaysOnTop;
});
// Fire-and-forget, not handle/invoke: setGlassMode() destroys the very
// webContents that sent this message, so a request/response round-trip
// would need to reply to a sender that may no longer exist by the time
// this returns. The fresh page reflects the new state itself once loaded
// (see syncGlassClassToRenderer).
ipcMain.on("window:toggle-glass", () => setGlassMode(!glassMode));

for (const action of ["play", "pause", "next", "previous"]) {
  ipcMain.on(`media:${action}`, () => {
    sendMediaCommand(action).catch((err) => debugLog(`media:${action} failed`, err.message));
  });
}

ipcMain.on("media:set-volume", (_event, level) => {
  if (typeof level !== "number" || !Number.isFinite(level)) return;
  setMediaVolume(level)
    .then((confirmed) => {
      if (confirmed == null) return;
      cachedVolume = confirmed;
      lastMediaState = { ...lastMediaState, volume: confirmed };
      mainWindow?.webContents.send("media:update", lastMediaState);
    })
    .catch((err) => debugLog("media:set-volume failed", err.message));
});
