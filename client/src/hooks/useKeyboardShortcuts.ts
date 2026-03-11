import { useEffect } from 'react';
import { useVoiceStore } from '../stores/voiceStore';

interface ShortcutHandlers {
  onOpenSearch?: () => void;
  onClosePanel?: () => void;
  onShowShortcuts?: () => void;
  onNavigateChannel?: (direction: 'up' | 'down') => void;
}

export function useKeyboardShortcuts(handlers: ShortcutHandlers) {
  const { connected, toggleMute, toggleDeafen } = useVoiceStore();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const isMod = e.metaKey || e.ctrlKey;
      const target = e.target as HTMLElement;
      const isInput =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable;

      // Ctrl/Cmd+K → Search (always, even in inputs)
      if (isMod && e.key === 'k') {
        e.preventDefault();
        handlers.onOpenSearch?.();
        return;
      }

      // Ctrl+/ → Show shortcuts
      if (isMod && e.key === '/') {
        e.preventDefault();
        handlers.onShowShortcuts?.();
        return;
      }

      // Escape → Close panels/modals
      if (e.key === 'Escape') {
        handlers.onClosePanel?.();
        return;
      }

      // Don't handle remaining shortcuts when typing
      if (isInput) return;

      // Ctrl+Shift+M → Toggle mute
      if (isMod && e.shiftKey && e.key === 'M') {
        e.preventDefault();
        if (connected) toggleMute();
        return;
      }

      // Ctrl+Shift+D → Toggle deafen
      if (isMod && e.shiftKey && e.key === 'D') {
        e.preventDefault();
        if (connected) toggleDeafen();
        return;
      }

      // Alt+Up/Down → Navigate channels
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        handlers.onNavigateChannel?.(e.key === 'ArrowUp' ? 'up' : 'down');
        return;
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handlers, connected, toggleMute, toggleDeafen]);
}
