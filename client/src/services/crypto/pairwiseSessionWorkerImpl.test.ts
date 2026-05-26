// Cover pairwiseSessionWorkerImpl ops.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const storeMock = vi.hoisted(() => ({
  savePairwiseSession: vi.fn(async () => {}),
  loadPairwiseSession: vi.fn(async () => null),
}));
vi.mock('./pairwiseSessionStoreWorkerImpl', () => storeMock);

const sessionMock = vi.hoisted(() => {
  const fake = {
    encrypt: vi.fn(async (pt: Uint8Array) => ({ header: { x3dh: null }, ciphertext: Array.from(pt) })),
    decrypt: vi.fn(async () => new Uint8Array([0x68, 0x69])),
    toJSON: vi.fn(() => ({ session: true })),
  };
  return {
    fake,
    RatchetSession: {
      fromJSON: vi.fn(() => fake),
      initAlice: vi.fn(async () => fake),
      initBob: vi.fn(async () => fake),
    },
  };
});
vi.mock('./ratchet', () => ({ RatchetSession: sessionMock.RatchetSession }));

vi.mock('./helpers', () => ({
  fromBase64: (s: string) => new Uint8Array(atob(s).split('').map((c) => c.charCodeAt(0))),
  toBase64: (b: Uint8Array) => btoa(String.fromCharCode(...b)),
}));

const x3dhMock = vi.hoisted(() => ({
  x3dhInitiate: vi.fn(async () => ({ sharedSecret: new Uint8Array(32), ephemeralPublicKey: new Uint8Array([9]), oneTimePreKeyIndex: 0 })),
  x3dhRespond: vi.fn(async () => new Uint8Array(32)),
}));
vi.mock('./x3dh', () => x3dhMock);

vi.mock('./x25519', () => ({
  importX25519PrivateKey: vi.fn(async () => ({} as CryptoKey)),
}));

vi.mock('./identityWorkerImpl', () => ({
  hasIdentityDhPrivateKey: vi.fn(() => true),
  getIdentityDhPrivateKey: vi.fn(() => ({} as CryptoKey)),
  getIdentityDhPublicKeyBytes: vi.fn(() => new Uint8Array([1, 2, 3])),
}));

vi.mock('./prekeyVaultWorkerImpl', () => ({
  getPrekeySecrets: vi.fn(async () => ({
    signed_prekey_private: new Uint8Array(32),
    one_time_prekey_privates: [new Uint8Array(32)],
  })),
}));

import {
  opPairwiseEncrypt, opPairwiseDecrypt,
  opPairwiseBootstrapAlice, opPairwiseBootstrapBob,
  resetPairwiseSessionCache,
} from './pairwiseSessionWorkerImpl';

beforeEach(() => {
  storeMock.savePairwiseSession.mockClear();
  storeMock.loadPairwiseSession.mockClear();
  Object.values(sessionMock.fake).forEach((f) => 'mockClear' in f && (f as { mockClear: () => void }).mockClear());
  sessionMock.RatchetSession.fromJSON.mockClear();
  sessionMock.RatchetSession.initAlice.mockClear();
  sessionMock.RatchetSession.initBob.mockClear();
  resetPairwiseSessionCache();
});

describe('opPairwiseEncrypt', () => {
  it('throws when no session exists', async () => {
    storeMock.loadPairwiseSession.mockResolvedValueOnce(null);
    await expect(opPairwiseEncrypt('peer1', btoa('hi'))).rejects.toThrow(/No pairwise session/);
  });

  it('encrypts when session exists', async () => {
    storeMock.loadPairwiseSession.mockResolvedValueOnce({ session: true });
    const out = await opPairwiseEncrypt('peer1', btoa('hi'));
    expect(typeof out).toBe('string');
    expect(storeMock.savePairwiseSession).toHaveBeenCalled();
  });
});

describe('opPairwiseDecrypt', () => {
  it('returns needsBootstrap when no session + message has x3dh', async () => {
    storeMock.loadPairwiseSession.mockResolvedValueOnce(null);
    const wire = btoa(JSON.stringify({ header: { x3dh: { identity_dh_key: [1] } }, ciphertext: [] }));
    const out = await opPairwiseDecrypt('peer1', wire);
    expect(out).toEqual({ ok: false, needsBootstrap: true });
  });

  it('throws when no session + no x3dh', async () => {
    storeMock.loadPairwiseSession.mockResolvedValueOnce(null);
    const wire = btoa(JSON.stringify({ header: {}, ciphertext: [] }));
    await expect(opPairwiseDecrypt('peer1', wire)).rejects.toThrow();
  });

  it('decrypts when session exists', async () => {
    storeMock.loadPairwiseSession.mockResolvedValueOnce({ session: true });
    const wire = btoa(JSON.stringify({ header: {}, ciphertext: [] }));
    const out = await opPairwiseDecrypt('peer1', wire);
    expect(out).toEqual({ ok: true, plaintextB64: expect.any(String) });
  });

  it('returns needsBootstrap on decrypt failure + x3dh header', async () => {
    storeMock.loadPairwiseSession.mockResolvedValueOnce({ session: true });
    sessionMock.fake.decrypt.mockRejectedValueOnce(new Error('bad'));
    const wire = btoa(JSON.stringify({ header: { x3dh: { identity_dh_key: [1] } }, ciphertext: [] }));
    const out = await opPairwiseDecrypt('peer1', wire);
    expect(out).toEqual({ ok: false, needsBootstrap: true });
  });

  it('rethrows decrypt failure without x3dh header', async () => {
    storeMock.loadPairwiseSession.mockResolvedValueOnce({ session: true });
    sessionMock.fake.decrypt.mockRejectedValueOnce(new Error('bad'));
    const wire = btoa(JSON.stringify({ header: {}, ciphertext: [] }));
    await expect(opPairwiseDecrypt('peer1', wire)).rejects.toThrow();
  });
});

describe('opPairwiseBootstrapAlice', () => {
  it('produces a bootstrap header and persists session', async () => {
    const bundle = { signed_prekey: [1, 2, 3], identity_key: [], identity_dh_key: [], signed_prekey_signature: [], one_time_prekeys: [] };
    const out = await opPairwiseBootstrapAlice('peer1', bundle as never);
    expect(out.identity_dh_key).toEqual([1, 2, 3]);
    expect(storeMock.savePairwiseSession).toHaveBeenCalled();
  });

  it('throws when identity DH not initialised', async () => {
    const idMod = await import('./identityWorkerImpl');
    vi.mocked(idMod.hasIdentityDhPrivateKey).mockReturnValueOnce(false);
    const bundle = { signed_prekey: [1, 2, 3] };
    await expect(opPairwiseBootstrapAlice('peer1', bundle as never)).rejects.toThrow(/identity DH key not initialised/);
  });
});

describe('opPairwiseBootstrapBob', () => {
  it('runs X3DH respond + initBob, persists session', async () => {
    const bootstrap = { identity_dh_key: [1, 2], ephemeral_key: [3, 4], one_time_prekey_index: 0 };
    await opPairwiseBootstrapBob('peer1', bootstrap);
    expect(x3dhMock.x3dhRespond).toHaveBeenCalled();
    expect(storeMock.savePairwiseSession).toHaveBeenCalled();
  });

  it('handles null one_time_prekey_index', async () => {
    const bootstrap = { identity_dh_key: [1, 2], ephemeral_key: [3, 4], one_time_prekey_index: null };
    await opPairwiseBootstrapBob('peer1', bootstrap);
    expect(storeMock.savePairwiseSession).toHaveBeenCalled();
  });

  it('throws when identity DH missing', async () => {
    const idMod = await import('./identityWorkerImpl');
    vi.mocked(idMod.hasIdentityDhPrivateKey).mockReturnValueOnce(false);
    await expect(opPairwiseBootstrapBob('peer1', { identity_dh_key: [], ephemeral_key: [], one_time_prekey_index: null })).rejects.toThrow();
  });

  it('throws when prekey vault empty', async () => {
    const vault = await import('./prekeyVaultWorkerImpl');
    vi.mocked(vault.getPrekeySecrets).mockResolvedValueOnce(null);
    await expect(opPairwiseBootstrapBob('peer1', { identity_dh_key: [], ephemeral_key: [], one_time_prekey_index: null })).rejects.toThrow(/prekey vault empty/);
  });
});

describe('resetPairwiseSessionCache', () => {
  it('clears the cache', async () => {
    storeMock.loadPairwiseSession.mockResolvedValue({ session: true });
    await opPairwiseEncrypt('peer1', btoa('hi'));
    resetPairwiseSessionCache();
    storeMock.loadPairwiseSession.mockClear();
    await opPairwiseEncrypt('peer1', btoa('hi'));
    expect(storeMock.loadPairwiseSession).toHaveBeenCalled();
  });
});
