import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useCryptoRestore } from './useCryptoRestore';

const restoreDerivedKeyMock = vi.fn();
const restorePassphraseMock = vi.fn();
const restoreEncryptedAuthDataMock = vi.fn(async () => {});
const setDerivedKeyMock = vi.fn();
let stateDerivedKey: string | null = null;

vi.mock('../stores/authStore', () => ({
  useAuthStore: () => ({
    derivedKey: stateDerivedKey,
    setDerivedKey: setDerivedKeyMock,
  }),
  restoreDerivedKey: () => restoreDerivedKeyMock(),
  restorePassphrase: () => restorePassphraseMock(),
  restoreEncryptedAuthDataIntoStore: () => restoreEncryptedAuthDataMock(),
}));

const initCryptoMock = vi.fn(async () => {});
const isCryptoInitializedMock = vi.fn();
const unlockWithPrfMock = vi.fn(async () => ({}));
const unlockWithPassphraseMock = vi.fn(async () => ({}));
const hasPasskeyKeySlotMock = vi.fn();
const hasPasswordSlotMock = vi.fn();

vi.mock('../services/crypto', () => ({
  initCrypto: (...a: unknown[]) => initCryptoMock(...a),
  isCryptoInitialized: () => isCryptoInitializedMock(),
}));

vi.mock('../services/keyStore', () => ({
  unlockWithPrf: (...a: unknown[]) => unlockWithPrfMock(...a),
  unlockWithPassphrase: (...a: unknown[]) => unlockWithPassphraseMock(...a),
  hasPasskeyKeySlot: () => hasPasskeyKeySlotMock(),
  hasPasswordSlot: () => hasPasswordSlotMock(),
}));

vi.mock('../services/cryptoCore', () => ({
  fromBase64: (s: string) => new Uint8Array([s.length & 0xff]),
}));

const navigateMock = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
}));

describe('useCryptoRestore', () => {
  beforeEach(() => {
    stateDerivedKey = null;
    restoreDerivedKeyMock.mockReset();
    restorePassphraseMock.mockReset();
    restoreEncryptedAuthDataMock.mockClear();
    setDerivedKeyMock.mockReset();
    initCryptoMock.mockReset().mockResolvedValue(undefined);
    isCryptoInitializedMock.mockReset();
    unlockWithPrfMock.mockReset().mockResolvedValue({});
    unlockWithPassphraseMock.mockReset().mockResolvedValue({});
    hasPasskeyKeySlotMock.mockReset();
    hasPasswordSlotMock.mockReset();
    navigateMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns cryptoReady=false until restore completes', () => {
    restoreDerivedKeyMock.mockResolvedValue('restored-key');
    const { result } = renderHook(() => useCryptoRestore());
    expect(result.current.cryptoReady).toBe(false);
  });

  it('marks cryptoReady=true when there is no persisted derivedKey to restore', async () => {
    restoreDerivedKeyMock.mockResolvedValue(null);
    const { result } = renderHook(() => useCryptoRestore());
    await waitFor(() => expect(result.current.cryptoReady).toBe(true));
    expect(setDerivedKeyMock).not.toHaveBeenCalled();
  });

  it('calls setDerivedKey when sessionStorage has a key', async () => {
    restoreDerivedKeyMock.mockResolvedValue('persisted-key');
    renderHook(() => useCryptoRestore());
    await waitFor(() => expect(setDerivedKeyMock).toHaveBeenCalledWith('persisted-key'));
  });

  it('skips the unlock dance if crypto is already initialized', async () => {
    stateDerivedKey = 'derived';
    isCryptoInitializedMock.mockReturnValue(true);
    const { result } = renderHook(() => useCryptoRestore());
    await waitFor(() => expect(result.current.cryptoReady).toBe(true));
    expect(unlockWithPrfMock).not.toHaveBeenCalled();
    expect(unlockWithPassphraseMock).not.toHaveBeenCalled();
  });

  it('uses passkey PRF unlock when hasPasskeyKeySlot is true', async () => {
    stateDerivedKey = 'derived';
    isCryptoInitializedMock.mockReturnValue(false);
    hasPasskeyKeySlotMock.mockResolvedValue(true);
    hasPasswordSlotMock.mockResolvedValue(false);
    const { result } = renderHook(() => useCryptoRestore());
    await waitFor(() => expect(unlockWithPrfMock).toHaveBeenCalledTimes(1));
    expect(initCryptoMock).toHaveBeenCalledTimes(1);
    expect(result.current.cryptoReady).toBe(true);
  });

  it('uses passphrase unlock when only password slot is present', async () => {
    stateDerivedKey = 'derived';
    isCryptoInitializedMock.mockReturnValue(false);
    hasPasskeyKeySlotMock.mockResolvedValue(false);
    hasPasswordSlotMock.mockResolvedValue(true);
    restorePassphraseMock.mockResolvedValue('secret');
    renderHook(() => useCryptoRestore());
    await waitFor(() => expect(unlockWithPassphraseMock).toHaveBeenCalledWith('secret'));
  });

  it('redirects to /login when password slot exists but no persisted passphrase', async () => {
    stateDerivedKey = 'derived';
    isCryptoInitializedMock.mockReturnValue(false);
    hasPasskeyKeySlotMock.mockResolvedValue(false);
    hasPasswordSlotMock.mockResolvedValue(true);
    restorePassphraseMock.mockResolvedValue(null);
    renderHook(() => useCryptoRestore());
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/login'));
    expect(unlockWithPassphraseMock).not.toHaveBeenCalled();
  });

  it('redirects to /login when the persisted passphrase is rejected', async () => {
    stateDerivedKey = 'derived';
    isCryptoInitializedMock.mockReturnValue(false);
    hasPasskeyKeySlotMock.mockResolvedValue(false);
    hasPasswordSlotMock.mockResolvedValue(true);
    restorePassphraseMock.mockResolvedValue('wrong');
    unlockWithPassphraseMock.mockRejectedValue(new Error('bad passphrase'));
    renderHook(() => useCryptoRestore());
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/login'));
  });

  it('still sets cryptoReady=true even if no unlock slot exists (failure path)', async () => {
    stateDerivedKey = 'derived';
    isCryptoInitializedMock.mockReturnValue(false);
    hasPasskeyKeySlotMock.mockResolvedValue(false);
    hasPasswordSlotMock.mockResolvedValue(false);
    const { result } = renderHook(() => useCryptoRestore());
    await waitFor(() => expect(result.current.cryptoReady).toBe(true));
  });
});
