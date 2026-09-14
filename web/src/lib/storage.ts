/** localStorage read that never throws: the Electron first run (and a
 * blocked storage) raise a SecurityError, which used to blank the view when
 * it happened inside a useState initializer. */
export function getLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
