// Minimal bridge for the UI (loaded over http): native file picking only.
// The web app detects `window.desktop` to show Browse buttons in Electron
// and falls back to manual typing in a plain browser.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  /**
   * Opens the native file picker; resolves with the absolute path or null.
   * @param {{ title?: string, filters?: { name: string, extensions: string[] }[] }} opts
   */
  pickFile: (opts) => ipcRenderer.invoke("pick-file", opts ?? {}),
  /**
   * Native confirm/alert (main-process dialogs): the renderer's built-in
   * window.confirm/alert break keyboard focus in Electron.
   */
  confirm: (message) => ipcRenderer.sendSync("confirm-sync", String(message)),
  alert: (message) => ipcRenderer.sendSync("alert-sync", String(message)),
});
