import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useCustomTheme } from './useCustomTheme';

function mockFetch(data: unknown, ok = true): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok,
    json: () => Promise.resolve(data),
  } as Response);
}

describe('useCustomTheme', () => {
  beforeEach(() => {
    // Remove any existing custom theme link tags
    document.querySelectorAll('link[data-custom-theme]').forEach((el) => el.remove());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('injects a <link> tag when server reports has_custom_theme: true', async () => {
    mockFetch({ has_custom_theme: true });

    renderHook(() => useCustomTheme());

    await waitFor(() => {
      const link = document.querySelector('link[data-custom-theme="true"]');
      expect(link).not.toBeNull();
    });

    const link = document.querySelector('link[data-custom-theme="true"]') as HTMLLinkElement;
    expect(link.rel).toBe('stylesheet');
    expect(link.href).toContain('/theme/custom.css');
  });

  it('does NOT inject a link tag when has_custom_theme: false', async () => {
    mockFetch({ has_custom_theme: false });

    renderHook(() => useCustomTheme());

    // Wait for the fetch to resolve
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/v1/config');
    });

    const link = document.querySelector('link[data-custom-theme="true"]');
    expect(link).toBeNull();
  });

  it('cleans up the link tag on unmount', async () => {
    mockFetch({ has_custom_theme: true });

    const { unmount } = renderHook(() => useCustomTheme());

    await waitFor(() => {
      expect(document.querySelector('link[data-custom-theme="true"]')).not.toBeNull();
    });

    unmount();

    expect(document.querySelector('link[data-custom-theme="true"]')).toBeNull();
  });

  it('silently catches fetch errors without injecting a link tag', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

    renderHook(() => useCustomTheme());

    // Wait for the fetch rejection to propagate
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/v1/config');
    });

    const link = document.querySelector('link[data-custom-theme="true"]');
    expect(link).toBeNull();
  });
});
