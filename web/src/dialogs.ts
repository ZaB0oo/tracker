/**
 * confirm/alert wrappers. In Electron, the renderer's native window.confirm /
 * window.alert break keyboard focus (inputs stay dead until the window is
 * refocused — upstream bug), so the desktop bridge routes them to real native
 * dialogs shown by the main process. Plain browsers use the built-ins.
 */

export function appConfirm(message: string): boolean {
  if (window.desktop?.confirm) return window.desktop.confirm(message);
  return window.confirm(message);
}

export function appAlert(message: string): void {
  if (window.desktop?.alert) {
    window.desktop.alert(message);
    return;
  }
  window.alert(message);
}
