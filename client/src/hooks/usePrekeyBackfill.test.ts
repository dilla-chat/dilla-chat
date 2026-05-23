import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { usePrekeyBackfill } from './usePrekeyBackfill';
import { useAuthStore } from '../stores/authStore';

const getPrekeyBundleMock = vi.fn();
const uploadPrekeyBundleMock = vi.fn();
const hasPrekeySecretsMock = vi.fn();

vi.mock('../services/api', () => ({
  api: { getPrekeyBundle: (...a: unknown[]) => getPrekeyBundleMock(...a) },
}));

vi.mock('../services/crypto', () => ({
  cryptoService: { hasPrekeySecrets: () => hasPrekeySecretsMock() },
}));

vi.mock('../utils/serverConnection', () => ({
  uploadPrekeyBundle: (...a: unknown[]) => uploadPrekeyBundleMock(...a),
}));

describe('usePrekeyBackfill', () => {
  beforeEach(() => {
    useAuthStore.setState({
      teams: new Map([
        ['t1', {
          baseUrl: 'https://srv.example',
          token: 'jwt',
          user: { id: 'u1' },
          publicKeyHex: '',
        }],
      ]) as never,
      derivedKey: 'derived' as never,
    });
    getPrekeyBundleMock.mockReset();
    uploadPrekeyBundleMock.mockReset().mockResolvedValue(undefined);
    hasPrekeySecretsMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not upload while crypto is not ready', async () => {
    const { result: dl } = renderHook(() => useRef(new Set(['t1'])));
    renderHook(() => usePrekeyBackfill('t1', dl.current, /*cryptoReady*/ false));
    await new Promise((r) => setTimeout(r, 20));
    expect(uploadPrekeyBundleMock).not.toHaveBeenCalled();
  });

  it('does not upload when activeTeamId is null', async () => {
    const { result: dl } = renderHook(() => useRef(new Set<string>()));
    renderHook(() => usePrekeyBackfill(null, dl.current, true));
    await new Promise((r) => setTimeout(r, 20));
    expect(uploadPrekeyBundleMock).not.toHaveBeenCalled();
  });

  it('does not upload when derivedKey is null', async () => {
    useAuthStore.setState({ derivedKey: null });
    const { result: dl } = renderHook(() => useRef(new Set(['t1'])));
    renderHook(() => usePrekeyBackfill('t1', dl.current, true));
    await new Promise((r) => setTimeout(r, 20));
    expect(uploadPrekeyBundleMock).not.toHaveBeenCalled();
  });

  it('skips upload when server already has a bundle AND local secrets exist', async () => {
    getPrekeyBundleMock.mockResolvedValue({ identity_key: [] });
    hasPrekeySecretsMock.mockReturnValue(true);
    const { result: dl } = renderHook(() => useRef(new Set(['t1'])));
    renderHook(() => usePrekeyBackfill('t1', dl.current, true));
    await new Promise((r) => setTimeout(r, 20));
    expect(uploadPrekeyBundleMock).not.toHaveBeenCalled();
  });

  it('uploads when server has no bundle (404)', async () => {
    getPrekeyBundleMock.mockRejectedValue(new Error('prekey bundle not found'));
    hasPrekeySecretsMock.mockReturnValue(true);
    const { result: dl } = renderHook(() => useRef(new Set(['t1'])));
    renderHook(() => usePrekeyBackfill('t1', dl.current, true));
    await waitFor(() => expect(uploadPrekeyBundleMock).toHaveBeenCalledTimes(1));
    expect(uploadPrekeyBundleMock).toHaveBeenCalledWith('derived', 't1');
  });

  it('uploads when local secrets are missing (post-format-upgrade case)', async () => {
    getPrekeyBundleMock.mockResolvedValue({ identity_key: [] });
    hasPrekeySecretsMock.mockReturnValue(false);
    const { result: dl } = renderHook(() => useRef(new Set(['t1'])));
    renderHook(() => usePrekeyBackfill('t1', dl.current, true));
    await waitFor(() => expect(uploadPrekeyBundleMock).toHaveBeenCalledTimes(1));
  });

  it('does NOT upload on non-404 errors from getPrekeyBundle', async () => {
    getPrekeyBundleMock.mockRejectedValue(new Error('500 internal server error'));
    hasPrekeySecretsMock.mockReturnValue(false);
    const { result: dl } = renderHook(() => useRef(new Set(['t1'])));
    renderHook(() => usePrekeyBackfill('t1', dl.current, true));
    await new Promise((r) => setTimeout(r, 20));
    expect(uploadPrekeyBundleMock).not.toHaveBeenCalled();
  });
});
