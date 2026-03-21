import { useCallback, useEffect, useState } from 'react';
import './TitleBar.css';

type Platform = 'macos' | 'windows' | 'linux';

function detectPlatform(): Platform {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('mac')) return 'macos';
  if (ua.includes('win')) return 'windows';
  return 'linux';
}

export default function TitleBar() {
  const [isTauri, setIsTauri] = useState(false);
  const [platform, setPlatform] = useState<Platform>('linux');

  useEffect(() => {
    const tauriAvailable = globalThis.window !== undefined && '__TAURI_INTERNALS__' in globalThis;
    setIsTauri(tauriAvailable);
    setPlatform(detectPlatform());
  }, []);

  const handleClose = useCallback(async () => {
    if (!('__TAURI_INTERNALS__' in globalThis)) return;
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    getCurrentWindow().close();
  }, []);

  const handleMinimize = useCallback(async () => {
    if (!('__TAURI_INTERNALS__' in globalThis)) return;
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    getCurrentWindow().minimize();
  }, []);

  const handleMaximize = useCallback(async () => {
    if (!('__TAURI_INTERNALS__' in globalThis)) return;
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    getCurrentWindow().toggleMaximize();
  }, []);

  if (!isTauri) return null;

  // macOS uses native traffic lights via titleBarStyle: "Overlay"
  // We just need a drag region on macOS
  if (platform === 'macos') {
    return <div className="titlebar titlebar-macos" data-tauri-drag-region />;
  }

  // Windows/Linux: custom window controls on the right
  return (
    <div className="titlebar titlebar-win" data-tauri-drag-region>
      <div className="titlebar-win-controls">
        <button className="titlebar-win-btn" onClick={handleMinimize} aria-label="Minimize">
          <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor"/></svg>
        </button>
        <button className="titlebar-win-btn" onClick={handleMaximize} aria-label="Maximize">
          <svg width="10" height="10" viewBox="0 0 10 10"><rect width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1"/></svg>
        </button>
        <button className="titlebar-win-btn titlebar-win-close" onClick={handleClose} aria-label="Close">
          <svg width="10" height="10" viewBox="0 0 10 10"><line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2"/><line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1.2"/></svg>
        </button>
      </div>
    </div>
  );
}
