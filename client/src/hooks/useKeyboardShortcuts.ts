import { useEffect } from 'react';
import { useVoiceConnection } from './useVoiceConnection';

interface ShortcutHandlers {
  onOpenSearch?: () => void;
  onClosePanel?: () => void;
  onShowShortcuts?: () => void;
  onNavigateChannel?: (direction: 'up' | 'down') => void;
}

function isInputElement(target: HTMLElement): boolean {
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.isContentEditable
  );
}

function handleGlobalShortcut(e: KeyboardEvent, handlers: ShortcutHandlers): boolean {
  const isMod = e.metaKey || e.ctrlKey;

  if (isMod && e.key === 'k') {
    e.preventDefault();
    handlers.onOpenSearch?.();
    return true;
  }

  if (isMod && e.key === '/') {
    e.preventDefault();
    handlers.onShowShortcuts?.();
    return true;
  }

  if (e.key === 'Escape') {
    handlers.onClosePanel?.();
    return true;
  }

  return false;
}

function handleNonInputShortcut(
  e: KeyboardEvent,
  handlers: ShortcutHandlers,
  connected: boolean,
  toggleMute: () => void,
  toggleDeafen: () => void,
): void {
  const isMod = e.metaKey || e.ctrlKey;

  if (isMod && e.shiftKey && e.key === 'M') {
    e.preventDefault();
    if (connected) toggleMute();
    return;
  }

  if (isMod && e.shiftKey && e.key === 'D') {
    e.preventDefault();
    if (connected) toggleDeafen();
    return;
  }

  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    handlers.onNavigateChannel?.(e.key === 'ArrowUp' ? 'up' : 'down');
  }
}

export function useKeyboardShortcuts(handlers: ShortcutHandlers) {
  const { connected, toggleMute, toggleDeafen } = useVoiceConnection();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (handleGlobalShortcut(e, handlers)) return;

      const target = e.target as HTMLElement;
      if (isInputElement(target)) return;

      handleNonInputShortcut(e, handlers, connected, toggleMute, toggleDeafen);
    }

    globalThis.addEventListener('keydown', handleKeyDown);
    return () => globalThis.removeEventListener('keydown', handleKeyDown);
  }, [handlers, connected, toggleMute, toggleDeafen]);
}
