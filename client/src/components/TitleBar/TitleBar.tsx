import { useCallback, useEffect, useState } from 'react';

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
    return (
      <div
        className="titlebar fixed top-0 left-0 right-0 h-[var(--titlebar-height)] z-[9999] flex items-center justify-start select-none bg-transparent"
        data-tauri-drag-region
      />
    );
  }

  // Windows/Linux: custom window controls on the right
  return (
    <div
      className="titlebar fixed top-0 left-0 right-0 h-[var(--titlebar-height)] z-[9999] flex items-center justify-end select-none bg-transparent"
      data-tauri-drag-region
    >
      <div className="titlebar-no-drag flex items-center h-full">
        <button
          className="flex items-center justify-center w-[46px] h-full border-none bg-transparent text-foreground cursor-pointer p-0 transition-colors duration-100 ease-linear hover:bg-white-overlay-subtle"
          onClick={handleMinimize}
          aria-label="Minimize"
        >
          <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor"/></svg>
        </button>
        <button
          className="flex items-center justify-center w-[46px] h-full border-none bg-transparent text-foreground cursor-pointer p-0 transition-colors duration-100 ease-linear hover:bg-white-overlay-subtle"
          onClick={handleMaximize}
          aria-label="Maximize"
        >
          <svg width="10" height="10" viewBox="0 0 10 10"><rect width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1"/></svg>
        </button>
        <button
          className="flex items-center justify-center w-[46px] h-full border-none bg-transparent text-foreground cursor-pointer p-0 transition-colors duration-100 ease-linear hover:bg-[#e81123] hover:text-white"
          onClick={handleClose}
          aria-label="Close"
        >
          <svg width="10" height="10" viewBox="0 0 10 10"><line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2"/><line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1.2"/></svg>
        </button>
      </div>
    </div>
  );
}
