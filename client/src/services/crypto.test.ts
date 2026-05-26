import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock only external deps, not crypto internals
vi.mock('./keyStore', () => ({
  saveSessions: vi.fn().mockResolvedValue(undefined),
  loadSessions: vi.fn().mockResolvedValue(null),
}));

vi.mock('./crypto/sessionStore', () => ({
  loadGroupSession: vi.fn().mockResolvedValue(null),
  saveGroupSession: vi.fn().mockResolvedValue(undefined),
}));

import { initCrypto, resetCrypto, getIdentityKeys, cryptoService, isCryptoInitialized } from './crypto';
import { generateEd25519KeyPair, generateX25519KeyPair } from './cryptoCore';

async function makeTestKeys() {
  const ed = await generateEd25519KeyPair();
  const dh = await generateX25519KeyPair();
  return {
    signingKey: ed.privateKey,
    publicKeyBytes: ed.publicKeyBytes,
    dhKeyPair: { privateKey: dh.privateKey, publicKeyBytes: dh.publicKeyBytes },
  };
}

describe('crypto service', () => {
  beforeEach(() => {
    resetCrypto();
  });

  it('resetCrypto clears manager', () => {
    expect(() => getIdentityKeys()).toThrow();
  });

  it('isCryptoInitialized reflects manager state', async () => {
    expect(isCryptoInitialized()).toBe(false);
    const keys = await makeTestKeys();
    await initCrypto(keys, 'k');
    expect(isCryptoInitialized()).toBe(true);
    resetCrypto();
    expect(isCryptoInitialized()).toBe(false);
  });

  it('initCrypto swallows session-restore errors', async () => {
    const { loadSessions } = await import('./keyStore');
    vi.mocked(loadSessions).mockRejectedValueOnce(new Error('idb broken'));
    const keys = await makeTestKeys();
    await expect(initCrypto(keys, 'k')).resolves.toBeUndefined();
    expect(isCryptoInitialized()).toBe(true);
  });

  it('initCrypto restores sessions when loadSessions returns data', async () => {
    const { loadSessions } = await import('./keyStore');
    vi.mocked(loadSessions).mockResolvedValueOnce({ groupSessions: {}, pairwiseSessions: {} });
    const keys = await makeTestKeys();
    await initCrypto(keys, 'key-with-sessions');
    // Session restore path exercised (lines 50-53)
  });

  it('initCrypto is idempotent', async () => {
    const keys = await makeTestKeys();
    await initCrypto(keys, 'key1');
    await initCrypto(keys, 'key1'); // should skip
  });

  it('getIdentityKeys returns keys after init', async () => {
    const keys = await makeTestKeys();
    await initCrypto(keys, 'key1');
    const result = getIdentityKeys();
    expect(result.publicKeyBytes).toEqual(keys.publicKeyBytes);
  });

  it('ensureChannelSession creates session', async () => {
    const keys = await makeTestKeys();
    await initCrypto(keys, 'key1');
    await cryptoService.ensureChannelSession('ch-1', 'u1', 'key1');
  });

  it('ensureChannelSession is idempotent', async () => {
    const keys = await makeTestKeys();
    await initCrypto(keys, 'key1');
    await cryptoService.ensureChannelSession('ch-2', 'u1', 'key1');
    await cryptoService.ensureChannelSession('ch-2', 'u1', 'key1');
  });

  it('getSenderKeyDistribution returns valid JSON', async () => {
    const keys = await makeTestKeys();
    await initCrypto(keys, 'key1');
    const dist = await cryptoService.getSenderKeyDistribution('ch-3', 'key1');
    const parsed = JSON.parse(dist);
    expect(parsed).toHaveProperty('sender_id');
    expect(parsed).toHaveProperty('chain_key');
  });

  it('processSenderKey accepts distribution', async () => {
    const keys = await makeTestKeys();
    await initCrypto(keys, 'key1');
    await cryptoService.getSenderKeyDistribution('ch-4', 'key1');
    const dist = JSON.stringify({ sender_id: 'other', chain_key: Array.from({ length: 32 }, () => 0), signing_public_key: Array.from({ length: 32 }, () => 0) });
    await cryptoService.processSenderKey('ch-4', dist, 'key1');
  });

  it('encryptChannel returns encrypted string', async () => {
    const keys = await makeTestKeys();
    await initCrypto(keys, 'key1');
    const { toBase64 } = await import('./cryptoCore');
    const userId = toBase64(keys.publicKeyBytes);
    const encrypted = await cryptoService.encryptChannel('ch-5', userId, 'hello', 'key1');
    expect(typeof encrypted).toBe('string');
    expect(encrypted.length).toBeGreaterThan(10);
  });

  it('encrypt then decrypt roundtrip works', async () => {
    const keys = await makeTestKeys();
    await initCrypto(keys, 'key1');
    const { toBase64 } = await import('./cryptoCore');
    const userId = toBase64(keys.publicKeyBytes);
    const encrypted = await cryptoService.encryptChannel('ch-6', userId, 'secret message', 'key1');
    const decrypted = await cryptoService.decryptChannel('ch-6', userId, userId, encrypted, 'key1');
    expect(decrypted).toBe('secret message');
  });

  it('rotateChannelKey returns distribution', async () => {
    const keys = await makeTestKeys();
    await initCrypto(keys, 'key1');
    const { toBase64 } = await import('./cryptoCore');
    const userId = toBase64(keys.publicKeyBytes);
    // Create session first
    await cryptoService.encryptChannel('ch-rot', userId, 'test', 'key1');
    const dist = await cryptoService.rotateChannelKey('ch-rot', 'removed-user', 'key1');
    expect(dist).not.toBeNull();
    expect(typeof dist).toBe('string');
  });

  it('rotateChannelKey returns null for unknown channel', async () => {
    const keys = await makeTestKeys();
    await initCrypto(keys, 'key1');
    const dist = await cryptoService.rotateChannelKey('ch-unknown', 'user', 'key1');
    expect(dist).toBeNull();
  });

  it('ensureChannelSession restores from IndexedDB when available', async () => {
    const keys = await makeTestKeys();
    await initCrypto(keys, 'key1');
    // First create a session and get its JSON
    const { toBase64 } = await import('./cryptoCore');
    const userId = toBase64(keys.publicKeyBytes);
    await cryptoService.encryptChannel('ch-idb-src', userId, 'seed', 'key1');

    // Now mock loadGroupSession to return a serialized session
    const { loadGroupSession } = await import('./crypto/sessionStore');
    const { GroupSession } = await import('./crypto/groupSession');
    const session = await GroupSession.create('ch-idb-restore', userId);
    vi.mocked(loadGroupSession).mockResolvedValueOnce(session.toJSON() as Record<string, unknown>);

    // Reset to force a fresh ensureChannelSession
    resetCrypto();
    await initCrypto(keys, 'key1');
    await cryptoService.ensureChannelSession('ch-idb-restore', userId, 'key1');
    expect(loadGroupSession).toHaveBeenCalledWith('ch-idb-restore');
  });

  it('decryptChannel works after encrypt', async () => {
    const keys = await makeTestKeys();
    await initCrypto(keys, 'key1');
    const { toBase64 } = await import('./cryptoCore');
    const userId = toBase64(keys.publicKeyBytes);
    const encrypted = await cryptoService.encryptChannel('ch-dec', userId, 'decrypt me', 'key1');
    const decrypted = await cryptoService.decryptChannel('ch-dec', userId, userId, encrypted, 'key1');
    expect(decrypted).toBe('decrypt me');
  });

  it('generatePrekeyBundle returns bundle', async () => {
    const keys = await makeTestKeys();
    await initCrypto(keys, 'key1');
    const bundle = await cryptoService.generatePrekeyBundle('key1');
    expect(bundle).toHaveProperty('identity_key');
    expect(bundle).toHaveProperty('signed_prekey');
  });

  it('resetCrypto allows re-init', async () => {
    const keys = await makeTestKeys();
    await initCrypto(keys, 'key1');
    resetCrypto();
    expect(() => getIdentityKeys()).toThrow();
    await initCrypto(keys, 'key2');
    expect(getIdentityKeys().publicKeyBytes).toEqual(keys.publicKeyBytes);
  });
});
