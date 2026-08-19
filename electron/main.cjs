const { app, BrowserWindow, Tray, Menu, ipcMain, session, desktopCapturer, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");

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

const iconPath = path.join(__dirname, "icon.png");

// The window is always created with transparent:true so glass mode can be
// switched on later without recreating it (Electron only lets you set
// `transparent` at construction time). Off by default, setBackgroundColor
// paints it fully solid — pixel-identical to the old opaque window.
function applyGlassMode(win, enabled) {
  glassMode = enabled;
  if (process.platform === "win32") {
    try {
      // Windows 11 22H2+ only; older Windows throws, so fall back to plain
      // (unblurred) transparency instead of a solid frosted appearance.
      win.setBackgroundMaterial(enabled ? "acrylic" : "none");
    } catch (err) {
      // no-op: setBackgroundColor below still gives a see-through window
    }
  }
  win.setBackgroundColor(enabled ? "#00000000" : "#0a0a0f");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 660,
    minWidth: 400,
    minHeight: 420,
    frame: false,
    alwaysOnTop,
    transparent: true,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  applyGlassMode(mainWindow, false);
  mainWindow.webContents.on("render-process-gone", (_e, details) => debugLog("render-process-gone", details));
  mainWindow.on("unresponsive", () => debugLog("window unresponsive"));

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

  app.on("activate", showWindow);
});

app.on("before-quit", () => {
  isQuitting = true;
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
ipcMain.handle("window:toggle-glass", () => {
  if (mainWindow) applyGlassMode(mainWindow, !glassMode);
  return glassMode;
});
