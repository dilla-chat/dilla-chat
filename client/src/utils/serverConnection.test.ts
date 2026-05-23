import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { normalizeServerUrl, useServerHealthCheck, activateTeamAndNavigate } from './serverConnection';

describe('normalizeServerUrl', () => {
  it('prepends https:// when the address has no scheme', () => {
    expect(normalizeServerUrl('dilla.example')).toBe('https://dilla.example');
  });

  it('keeps the scheme when already http://', () => {
    expect(normalizeServerUrl('http://localhost:8080')).toBe('http://localhost:8080');
  });

  it('keeps the scheme when already https://', () => {
    expect(normalizeServerUrl('https://dilla.example')).toBe('https://dilla.example');
  });

  it('strips a single trailing slash', () => {
    expect(normalizeServerUrl('https://dilla.example/')).toBe('https://dilla.example');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeServerUrl('   dilla.example  ')).toBe('https://dilla.example');
  });
});

describe('useServerHealthCheck', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch' as never);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.useRealTimers();
  });

  it('returns "unknown" when the address is empty', async () => {
    const { result } = renderHook(() => useServerHealthCheck(''));
    await new Promise((r) => setTimeout(r, 600));
    expect(result.current[0]).toBe('unknown');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('flips to "online" when fetch resolves res.ok', async () => {
    fetchSpy.mockResolvedValue({ ok: true } as Response);
    const { result } = renderHook(() => useServerHealthCheck('dilla.example'));
    await waitFor(() => expect(result.current[0]).toBe('online'), { timeout: 2000 });
  });

  it('flips to "offline" when fetch resolves res.ok=false', async () => {
    fetchSpy.mockResolvedValue({ ok: false } as Response);
    const { result } = renderHook(() => useServerHealthCheck('dilla.example'));
    await waitFor(() => expect(result.current[0]).toBe('offline'), { timeout: 2000 });
  });

  it('flips to "offline" when fetch rejects', async () => {
    fetchSpy.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useServerHealthCheck('dilla.example'));
    await waitFor(() => expect(result.current[0]).toBe('offline'), { timeout: 2000 });
  });
});

describe('activateTeamAndNavigate', () => {
  it('calls navigate with /app', async () => {
    const navigate = vi.fn();
    await activateTeamAndNavigate('team-1', navigate);
    expect(navigate).toHaveBeenCalledWith('/app');
  });
});
