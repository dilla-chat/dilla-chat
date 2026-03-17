import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { useVoiceStore } from '../stores/voiceStore';

beforeEach(() => {
  useVoiceStore.setState({ connected: false, muted: false, deafened: false });
});

function fireKeyDown(opts: KeyboardEventInit) {
  window.dispatchEvent(new KeyboardEvent('keydown', { ...opts, bubbles: true }));
}

describe('useKeyboardShortcuts', () => {
  it('Ctrl+K calls onOpenSearch', () => {
    const onOpenSearch = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onOpenSearch }));
    fireKeyDown({ key: 'k', ctrlKey: true });
    expect(onOpenSearch).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+/ calls onShowShortcuts', () => {
    const onShowShortcuts = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onShowShortcuts }));
    fireKeyDown({ key: '/', ctrlKey: true });
    expect(onShowShortcuts).toHaveBeenCalledTimes(1);
  });

  it('Escape calls onClosePanel', () => {
    const onClosePanel = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onClosePanel }));
    fireKeyDown({ key: 'Escape' });
    expect(onClosePanel).toHaveBeenCalledTimes(1);
  });

  it('Alt+ArrowUp calls onNavigateChannel with up', () => {
    const onNavigateChannel = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onNavigateChannel }));
    fireKeyDown({ key: 'ArrowUp', altKey: true });
    expect(onNavigateChannel).toHaveBeenCalledWith('up');
  });

  it('Alt+ArrowDown calls onNavigateChannel with down', () => {
    const onNavigateChannel = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onNavigateChannel }));
    fireKeyDown({ key: 'ArrowDown', altKey: true });
    expect(onNavigateChannel).toHaveBeenCalledWith('down');
  });

  it('Ctrl+Shift+M toggles mute when voice connected', () => {
    useVoiceStore.setState({ connected: true, muted: false });
    renderHook(() => useKeyboardShortcuts({}));
    fireKeyDown({ key: 'M', ctrlKey: true, shiftKey: true });
    expect(useVoiceStore.getState().muted).toBe(true);
  });

  it('Ctrl+Shift+M does nothing when not connected', () => {
    useVoiceStore.setState({ connected: false, muted: false });
    renderHook(() => useKeyboardShortcuts({}));
    fireKeyDown({ key: 'M', ctrlKey: true, shiftKey: true });
    expect(useVoiceStore.getState().muted).toBe(false);
  });

  it('Ctrl+Shift+D toggles deafen when voice connected', () => {
    useVoiceStore.setState({ connected: true, deafened: false });
    renderHook(() => useKeyboardShortcuts({}));
    fireKeyDown({ key: 'D', ctrlKey: true, shiftKey: true });
    expect(useVoiceStore.getState().deafened).toBe(true);
  });
});
