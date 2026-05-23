import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
// useServerConfig is imported dynamically inside each test via
// `await import('./useServerConfig')` so the module-level cache resets
// between tests (we call vi.resetModules() first).

describe('useServerConfig', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Reset the module-level cache + inflight promise between tests.
    // The hook uses module-scoped state; resetModules and re-import
    // is the cleanest way to reset.
    vi.resetModules();
    fetchSpy = vi.spyOn(globalThis, 'fetch' as never);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns null on first render before the fetch lands', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        domain: 'test.local',
        rp_id: 'test.local',
        has_custom_theme: false,
        db_encrypted: true,
        tls_enabled: false,
      }),
    } as Response);
    const { useServerConfig: hook } = await import('./useServerConfig');
    const { result } = renderHook(() => hook());
    expect(result.current).toBeNull();
  });

  it('fetches /api/v1/config and exposes the response', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        domain: 'test.local',
        rp_id: 'test.local',
        has_custom_theme: false,
        db_encrypted: true,
        tls_enabled: false,
      }),
    } as Response);
    const { useServerConfig: hook } = await import('./useServerConfig');
    const { result } = renderHook(() => hook());
    await waitFor(() => expect(result.current?.db_encrypted).toBe(true));
    expect(fetchSpy).toHaveBeenCalledWith('/api/v1/config');
  });

  it('stays null when fetch responds with !ok', async () => {
    fetchSpy.mockResolvedValue({ ok: false } as Response);
    const { useServerConfig: hook } = await import('./useServerConfig');
    const { result } = renderHook(() => hook());
    await new Promise((r) => setTimeout(r, 100));
    expect(result.current).toBeNull();
  });

  it('stays null when fetch rejects (offline)', async () => {
    fetchSpy.mockRejectedValue(new Error('offline'));
    const { useServerConfig: hook } = await import('./useServerConfig');
    const { result } = renderHook(() => hook());
    await new Promise((r) => setTimeout(r, 100));
    expect(result.current).toBeNull();
  });

  it('shares the cached config across multiple hook instances', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        domain: 'cached.local',
        rp_id: 'cached.local',
        has_custom_theme: true,
        db_encrypted: false,
        tls_enabled: true,
      }),
    } as Response);
    const { useServerConfig: hook } = await import('./useServerConfig');
    const a = renderHook(() => hook());
    await waitFor(() => expect(a.result.current?.has_custom_theme).toBe(true));
    // Second instance reads from the module cache — no extra fetch.
    fetchSpy.mockClear();
    const b = renderHook(() => hook());
    expect(b.result.current?.has_custom_theme).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
