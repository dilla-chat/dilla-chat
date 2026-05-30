import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { useIdentityBackup } from './useIdentityBackup';
import { useAuthStore } from '../stores/authStore';

vi.mock('../services/keyStore', () => ({
  exportIdentityBlob: vi.fn(async () => 'fake-identity-blob'),
}));

vi.mock('../services/api', () => ({
  api: { getConnectionInfo: vi.fn(() => ({ token: 'session-jwt' })) },
  isSameOriginAsApi: vi.fn(() => false),
}));

describe('useIdentityBackup', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    useAuthStore.setState({
      teams: new Map([
        ['t1', { baseUrl: 'https://srv-a.example', token: 'jwt-a', userId: 'u', publicKeyHex: '' }],
        ['t2', { baseUrl: 'https://srv-b.example', token: 'jwt-b', userId: 'u', publicKeyHex: '' }],
      ]) as never,
      derivedKey: 'derived' as never,
    });
    fetchSpy = vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue({ ok: true } as Response);
    fetchSpy.mockClear();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('uploads the blob to every team server once derived key + activeTeamId are present', async () => {
    const { result: dataLoaded } = renderHook(() => useRef(new Set(['t1'])));
    renderHook(() => useIdentityBackup('t1', dataLoaded.current));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    const calls = fetchSpy.mock.calls.map((c) => c[0]);
    expect(calls).toContain('https://srv-a.example/api/v1/identity/blob');
    expect(calls).toContain('https://srv-b.example/api/v1/identity/blob');
  });

  it('does NOT upload when no active team id is set', async () => {
    const { result: dataLoaded } = renderHook(() => useRef(new Set<string>()));
    renderHook(() => useIdentityBackup(null, dataLoaded.current));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does NOT upload when derivedKey is null', async () => {
    useAuthStore.setState({ derivedKey: null });
    const { result: dataLoaded } = renderHook(() => useRef(new Set(['t1'])));
    renderHook(() => useIdentityBackup('t1', dataLoaded.current));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does NOT upload when the active team data has not loaded yet', async () => {
    const { result: dataLoaded } = renderHook(() => useRef(new Set<string>())); // t1 NOT in set
    renderHook(() => useIdentityBackup('t1', dataLoaded.current));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uploads with PUT method and JSON Content-Type', async () => {
    const { result: dataLoaded } = renderHook(() => useRef(new Set(['t1'])));
    renderHook(() => useIdentityBackup('t1', dataLoaded.current));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const opts = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(opts.method).toBe('PUT');
    expect((opts.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('attaches Bearer auth when target is NOT same-origin', async () => {
    const { result: dataLoaded } = renderHook(() => useRef(new Set(['t1'])));
    renderHook(() => useIdentityBackup('t1', dataLoaded.current));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const opts = fetchSpy.mock.calls[0][1] as RequestInit;
    expect((opts.headers as Record<string, string>).Authorization).toContain('Bearer ');
  });

  it('runs only once per session even if activeTeamId changes', async () => {
    const { result: dataLoaded } = renderHook(() => useRef(new Set(['t1', 't2'])));
    const { rerender } = renderHook(({ id }: { id: string }) => useIdentityBackup(id, dataLoaded.current), {
      initialProps: { id: 't1' },
    });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const callsAfterFirst = fetchSpy.mock.calls.length;
    rerender({ id: 't2' });
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchSpy.mock.calls.length).toBe(callsAfterFirst);
  });
});
