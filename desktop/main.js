/**
 * Electron shell: boots the existing Express server in a utilityProcess
 * (crash-isolated, same bundled Node runtime) and shows the UI in a window.
 *
 * Desktop behaviors:
 * - single instance (second launch focuses the existing window)
 * - close-to-tray: closing the window hides it, the tracker keeps polling;
 *   quit from the tray menu
 * - first launch: offers to import an existing tracker.db (source install)
 * - optional "start with Windows" (starts hidden in the tray)
 */
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  shell,
  Tray,
  utilityProcess,
} from "electron";
import path from "node:path";
import fs from "node:fs";

// Fixed port so OBS browser-source URLs (?overlay=1) stay stable.
const PORT = Number(process.env.TRACKER_PORT ?? 41100);
// Repo root in dev (desktop/..); phase 3 will adapt for the packaged asar.
const ROOT = path.join(import.meta.dirname, "..");
const ICON = path.join(import.meta.dirname, "icon.png");

const startHidden = process.argv.includes("--hidden");

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
  });
  // target=_blank links (osu.ppy.sh, GitHub release page…) open in the
  // system browser, not in a new Electron window
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  void win.loadURL(`http://127.0.0.1:${PORT}`);
  // close-to-tray: the tracker keeps running (polling, sweeps, Discord)
  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.on("closed", () => {
    win = null;
  });
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
        label: "Quit (stops the tracking)",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
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

// ---------- lifecycle ----------
app.whenReady().then(async () => {
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
