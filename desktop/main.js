/**
 * Electron shell: boots the existing Express server in a utilityProcess
 * (crash-isolated, same bundled Node runtime) and shows the UI in a window.
 *
 * Desktop behaviors:
 * - single instance (second launch focuses the existing window)
 * - closing the window asks whether to keep the tracker running in the tray or
 *   to quit (answer remembered on request, changeable from the tray menu)
 * - first launch: offers to import an existing tracker.db (source install)
 * - optional "start with Windows" (starts hidden in the tray)
 */
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  Tray,
  utilityProcess,
} from "electron";
import path from "node:path";
import fs from "node:fs";
import updater from "electron-updater"; // CJS package

const { autoUpdater } = updater;

// Fixed port so OBS browser-source URLs (?overlay=1) stay stable. Same
// default as the source install: existing osu! OAuth callback URLs and OBS
// browser sources keep working after migrating to the desktop app.
const PORT = Number(process.env.TRACKER_PORT ?? 3727);
// Repo root in dev (desktop/..); phase 3 will adapt for the packaged asar.
const ROOT = path.join(import.meta.dirname, "..");
const ICON = path.join(import.meta.dirname, "icon.png");

const startHidden = process.argv.includes("--hidden");

// Explicit, stable data location (%AppData%\osu-completionist) — otherwise
// dev runs ("electron desktop/main.js") default to %AppData%\Electron.
app.setName("osu-completionist");
app.setPath("userData", path.join(app.getPath("appData"), "osu-completionist"));

/** @type {ReturnType<typeof utilityProcess.fork> | null} */
let serverProc = null;
/** @type {BrowserWindow | null} */
let win = null;
/** @type {Tray | null} */
let tray = null;
let quitting = false;

// ---------- single instance ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
}

// ---------- data dir + first-launch import ----------
function dataDir() {
  return path.join(app.getPath("userData"), "data");
}

/**
 * First launch (no DB yet): offer to import a tracker.db from an existing
 * source install. Copy only — the original stays untouched. Must run BEFORE
 * the server starts (the file is free).
 */
function maybeImportDb() {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, "tracker.db");
  if (fs.existsSync(target)) return;
  const choice = dialog.showMessageBoxSync({
    type: "question",
    title: "osu!completionist",
    message: "Welcome!",
    detail:
      "If you already used the tracker (source install), you can import your " +
      "existing database — scores, catalog, settings and milestones included. " +
      "Close the old tracker first.\n\nOtherwise, start fresh: the app will " +
      "rebuild everything from the osu! API.",
    buttons: ["Import an existing tracker.db…", "Start fresh"],
    defaultId: 1,
    cancelId: 1,
  });
  if (choice !== 0) return;
  const picked = dialog.showOpenDialogSync({
    title: "Select your tracker.db",
    filters: [{ name: "tracker database", extensions: ["db"] }],
    properties: ["openFile"],
  });
  if (!picked?.[0]) return;
  const src = picked[0];
  try {
    fs.copyFileSync(src, target);
    // WAL sidecars hold recent writes when the source app wasn't cleanly
    // closed — copy them too when present
    for (const ext of ["-wal", "-shm"])
      if (fs.existsSync(src + ext)) fs.copyFileSync(src + ext, target + ext);
  } catch (e) {
    dialog.showErrorBox(
      "osu!completionist",
      `Could not import the database:\n${e instanceof Error ? e.message : e}`
    );
  }
}

// ---------- server ----------
function startServer() {
  const entry = path.join(ROOT, "dist", "server", "index.js");
  if (!fs.existsSync(entry)) {
    dialog.showErrorBox(
      "osu!completionist",
      `Server build not found:\n${entry}\n\nRun "npm run build" first (dev), or reinstall the app.`
    );
    app.quit();
    return;
  }
  serverProc = utilityProcess.fork(entry, [], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: path.join(dataDir(), "tracker.db"),
    },
    stdio: "inherit",
    serviceName: "osu-completionist-server",
  });
  serverProc.on("exit", (code) => {
    serverProc = null;
    if (code !== 0 && !quitting) {
      dialog.showErrorBox(
        "osu!completionist",
        `The tracker server stopped unexpectedly (code ${code}).`
      );
      app.quit();
    }
  });
}

/** Polls the API until the server answers (or times out). */
async function waitForServer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/version`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// ---------- window ----------
function showWindow() {
  if (win) {
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 900,
    minHeight: 600,
    autoHideMenuBar: true,
    backgroundColor: "#16121f",
    title: "osu!completionist",
    icon: ICON,
    webPreferences: {
      preload: path.join(import.meta.dirname, "preload.cjs"),
    },
  });
  // target=_blank links (osu.ppy.sh, GitHub release page…) open in the
  // system browser, not in a new Electron window
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  void win.loadURL(`http://127.0.0.1:${PORT}`);
  // Closing the window can either keep the tracker running in the tray or stop
  // everything. Asked once, remembered if the user ticks the box, and always
  // changeable from the tray menu.
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    const pref = readClosePref();
    if (pref === "quit") return doQuit();
    if (pref === "tray") return void win?.hide();
    void dialog
      .showMessageBox(win, {
        type: "question",
        buttons: ["Keep it running", "Quit"],
        defaultId: 0,
        cancelId: 0,
        title: "osu!completionist",
        message: "Close the window, or quit?",
        detail:
          "Kept in the tray, the tracker keeps picking up your new scores. Quitting stops it.",
        checkboxLabel: "Remember this",
        checkboxChecked: false,
      })
      .then(({ response, checkboxChecked }) => {
        const action = response === 1 ? "quit" : "tray";
        if (checkboxChecked) writeClosePref(action);
        refreshTrayMenu();
        if (action === "quit") doQuit();
        else win?.hide();
      });
  });
  win.on("closed", () => {
    win = null;
  });
}

// ---------- close behaviour ----------
const CLOSE_PREF = () => path.join(app.getPath("userData"), "close-action.json");

/** "tray", "quit", or null to ask every time. */
function readClosePref() {
  try {
    return JSON.parse(fs.readFileSync(CLOSE_PREF(), "utf8")).action ?? null;
  } catch {
    return null;
  }
}
function writeClosePref(action) {
  try {
    if (action === null) fs.rmSync(CLOSE_PREF(), { force: true });
    else fs.writeFileSync(CLOSE_PREF(), JSON.stringify({ action }));
  } catch {
    /* preference is a convenience, never worth failing on */
  }
}
function doQuit() {
  quitting = true;
  app.quit();
}

// ---------- tray ----------
function refreshTrayMenu() {
  if (!tray) return;
  const login = app.getLoginItemSettings();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open osu!completionist", click: () => showWindow() },
      {
        label: "Open the data folder",
        click: () => void shell.openPath(dataDir()),
      },
      { type: "separator" },
      {
        label: "Start with Windows (hidden)",
        type: "checkbox",
        checked: login.openAtLogin,
        click: (item) => {
          app.setLoginItemSettings({
            openAtLogin: item.checked,
            args: ["--hidden"],
          });
          refreshTrayMenu();
        },
      },
      { type: "separator" },
      {
        label: "When I close the window",
        submenu: [
          ["Ask me", null],
          ["Keep it running", "tray"],
          ["Quit", "quit"],
        ].map(([label, action]) => ({
          label,
          type: "radio",
          checked: readClosePref() === action,
          click: () => {
            writeClosePref(action);
            refreshTrayMenu();
          },
        })),
      },
      { type: "separator" },
      { label: "Quit (stops the tracking)", click: () => doQuit() },
    ])
  );
}

function createTray() {
  const img = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip(`osu!completionist — http://localhost:${PORT}`);
  tray.on("click", () => showWindow());
  refreshTrayMenu();
}

// ---------- auto-update ----------
/**
 * electron-updater against the GitHub releases of ZaB0oo/tracker (publish
 * config in package.json). Downloads in the background; a single dialog when
 * ready. Packaged builds only — dev runs skip it entirely.
 */
function setupAutoUpdate() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.on("error", (e) => {
    // offline / GitHub unreachable: silent, next periodic check will retry
    console.error("[updater]", e instanceof Error ? e.message : e);
  });
  autoUpdater.on("update-downloaded", (info) => {
    const choice = dialog.showMessageBoxSync({
      type: "info",
      title: "osu!completionist",
      message: `Update v${info.version} is ready`,
      detail:
        "It will be applied the next time the app starts — or restart now. " +
        "Your database is never touched by updates.",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice === 0) {
      quitting = true; // bypass close-to-tray so the installer can run
      autoUpdater.quitAndInstall();
    }
  });
  const check = () => void autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 6 * 3600 * 1000);
}

// native confirm/alert for the UI: the renderer's window.confirm/alert leave
// the window without keyboard focus afterwards (upstream Electron bug)
ipcMain.on("confirm-sync", (e, message) => {
  const opts = {
    type: "question",
    buttons: ["OK", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    title: "osu!completionist",
    message: String(message),
  };
  e.returnValue =
    (win ? dialog.showMessageBoxSync(win, opts) : dialog.showMessageBoxSync(opts)) === 0;
});
ipcMain.on("alert-sync", (e, message) => {
  const opts = {
    type: "info",
    buttons: ["OK"],
    title: "osu!completionist",
    message: String(message),
  };
  if (win) dialog.showMessageBoxSync(win, opts);
  else dialog.showMessageBoxSync(opts);
  e.returnValue = true;
});

// native file picker for the UI (Settings → LazerCollectionImporter path…)
ipcMain.handle("pick-file", async (_e, opts) => {
  const r = await dialog.showOpenDialog({
    title: typeof opts?.title === "string" ? opts.title : undefined,
    filters: Array.isArray(opts?.filters) ? opts.filters : undefined,
    properties: ["openFile"],
  });
  return r.canceled ? null : (r.filePaths[0] ?? null);
});

// ---------- lifecycle ----------
app.whenReady().then(async () => {
  setupAutoUpdate();
  maybeImportDb();
  startServer();
  createTray();
  const up = await waitForServer();
  if (!up) {
    dialog.showErrorBox(
      "osu!completionist",
      `The tracker server did not start within 30 s (port ${PORT}).`
    );
    quitting = true;
    app.quit();
    return;
  }
  if (!startHidden) showWindow();
});

// keep running when the window is closed (tray owns the lifecycle)
app.on("window-all-closed", () => {
  /* no quit: close-to-tray */
});

app.on("before-quit", () => {
  quitting = true;
  serverProc?.kill();
});
