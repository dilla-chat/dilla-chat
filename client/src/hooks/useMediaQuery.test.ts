import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMediaQuery, useIsMobile } from './useMediaQuery';

describe('useMediaQuery', () => {
  let listeners: Map<string, ((e: MediaQueryListEvent) => void)[]>;

  beforeEach(() => {
    listeners = new Map();
    vi.mocked(window.matchMedia).mockImplementation((query: string) => {
      const mql = {
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn((_, handler: (e: MediaQueryListEvent) => void) => {
          const existing = listeners.get(query) ?? [];
          existing.push(handler);
          listeners.set(query, existing);
        }),
        removeEventListener: vi.fn((_, handler: (e: MediaQueryListEvent) => void) => {
          const existing = listeners.get(query) ?? [];
          listeners.set(
            query,
            existing.filter((h) => h !== handler),
          );
        }),
        dispatchEvent: vi.fn(),
      };
      return mql;
    });
  });

  it('returns false when query does not match', () => {
    const { result } = renderHook(() => useMediaQuery('(max-width: 767px)'));
    expect(result.current).toBe(false);
  });

  it('returns true when query matches', () => {
    vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    const { result } = renderHook(() => useMediaQuery('(max-width: 767px)'));
    expect(result.current).toBe(true);
  });

  it('updates when media query changes', () => {
    const { result } = renderHook(() => useMediaQuery('(max-width: 767px)'));
    expect(result.current).toBe(false);

    act(() => {
      const handlers = listeners.get('(max-width: 767px)') ?? [];
      handlers.forEach((h) => h({ matches: true } as MediaQueryListEvent));
    });

    expect(result.current).toBe(true);
  });

  it('cleans up listener on unmount', () => {
    const removeEventListener = vi.fn();
    vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener,
      dispatchEvent: vi.fn(),
    }));

    const { unmount } = renderHook(() => useMediaQuery('(max-width: 767px)'));
    unmount();
    expect(removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });
});

describe('useIsMobile', () => {
  it('queries the correct breakpoint', () => {
    renderHook(() => useIsMobile());
    expect(window.matchMedia).toHaveBeenCalledWith('(max-width: 767px)');
  });
});
