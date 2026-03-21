/**
 * platform.ts — Runtime detection for Tauri vs Browser environments
 */

/** Returns true when running inside a Tauri desktop shell */
export function isTauri(): boolean {
  return globalThis.window !== undefined && '__TAURI_INTERNALS__' in globalThis;
}

/**
 * Get the data directory path.
 * - Tauri: uses appDataDir (OS-specific app data folder)
 * - Browser: returns a virtual path (unused — IndexedDB handles storage)
 */
export async function getDataDir(): Promise<string> {
  if (isTauri()) {
    try {
      const { appDataDir } = await import('@tauri-apps/api/path');
      return await appDataDir();
    } catch {
      return './dilla-data';
    }
  }
  return 'indexeddb'; // Sentinel — browser uses IndexedDB, not filesystem
}

/**
 * Get the base URL of the server that served this page (browser mode).
 * Returns null in Tauri (server address comes from user input).
 */
export function getOriginServerUrl(): string | null {
  if (isTauri()) return null;
  return globalThis.location.origin;
}
