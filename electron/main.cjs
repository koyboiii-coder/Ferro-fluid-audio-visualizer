const { app, BrowserWindow, Tray, Menu, ipcMain, session, desktopCapturer, nativeImage } = require("electron");
const path = require("path");

let mainWindow = null;
let tray = null;
let alwaysOnTop = true;
let isQuitting = false;

const iconPath = path.join(__dirname, "icon.png");

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 460,
    height: 640,
    minWidth: 340,
    minHeight: 420,
    frame: false,
    alwaysOnTop,
    backgroundColor: "#0a0a0f",
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
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
  tray.setToolTip("Ferrofluid Visualizer");

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
    desktopCapturer.getSources({ types: ["screen"] }).then((sources) => {
      callback({ video: sources[0], audio: "loopback" });
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
