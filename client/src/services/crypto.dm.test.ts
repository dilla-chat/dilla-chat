// Drive the DM / pairwise-session paths in services/crypto.ts that the
// existing crypto.test.ts doesn't cover: ensurePeerSession, encryptDM,
// decryptDM, wrapForPeer, unwrapFromPeer, getSafetyNumber, hasPrekeySecrets.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  managerMock: {
    encryptDM: vi.fn(async (peer: string, plaintext: string) => `ct-dm:${peer}:${plaintext}`),
    decryptDM: vi.fn(async (sender: string, ct: string) => `pt-dm:${sender}:${ct}`),
    encryptChannel: vi.fn(async (_c: string, _u: string, p: string) => `ct-ch:${p}`),
    decryptChannel: vi.fn(async (_c: string, _u: string, ct: string) => `pt-ch:${ct}`),
    initSessionWithBundle: vi.fn(async () => {}),
    generatePrekeyBundle: vi.fn(async () => ({ identity_key: 'A', identity_dh_key: 'A', signed_prekey: 'A', signed_prekey_signature: 'A', one_time_prekeys: ['A'] })),
    hasPrekeySecrets: vi.fn(() => true),
    getSafetyNumber: vi.fn((peer: string) => `sn:${peer}`),
    wrapForPeer: vi.fn(async () => 'wrapped'),
    unwrapFromPeer: vi.fn(async () => new Uint8Array([4, 5, 6])),
    processSenderKey: vi.fn(async () => {}),
    rotateChannelKey: vi.fn(async () => null),
    getSenderKeyDistribution: vi.fn(async () => 'dist'),
    toJSON: vi.fn(() => ({})),
    loadSessions: vi.fn(),
    groupSessions: new Map(),
  },
  getPrekeyBundle: vi.fn(async () => ({
    identity_key: 'YQ==', identity_dh_key: 'YQ==', signed_prekey: 'YQ==',
    signed_prekey_signature: 'YQ==', one_time_prekeys: ['YQ=='],
  })),
}));

vi.mock('./cryptoCore', () => ({
  CryptoManager: vi.fn().mockImplementation(function ManagerCtor(this: never) {
    return h.managerMock;
  }),
  fromBase64: (s: string) => new Uint8Array(atob(s).split('').map((c) => c.charCodeAt(0))),
  toBase64: (b: Uint8Array) => btoa(String.fromCharCode(...b)),
}));

vi.mock('./keyStore', () => ({
  saveSessions: vi.fn(async () => {}),
  loadSessions: vi.fn(async () => null),
}));

vi.mock('./api', () => ({
  api: { getPrekeyBundle: h.getPrekeyBundle },
}));

import { initCrypto, resetCrypto, cryptoService, getIdentityKeys } from './crypto';

const fakeKeys = {
  signingKey: { privateKey: {} as CryptoKey, publicKeyBytes: new Uint8Array([1]) },
  publicKeyBytes: new Uint8Array([1, 2, 3]),
  dhKeyPair: { privateKey: {} as CryptoKey, publicKeyBytes: new Uint8Array([4, 5, 6]) },
} as never;

beforeEach(async () => {
  resetCrypto();
  for (const fn of Object.values(h.managerMock)) {
    if (typeof fn === 'function' && 'mockClear' in fn) (fn as { mockClear: () => void }).mockClear();
  }
  h.getPrekeyBundle.mockClear();
  await initCrypto(fakeKeys, 'dk');
});

afterEach(() => resetCrypto());

describe('getIdentityKeys', () => {
  it('returns the injected identity', () => {
    const k = getIdentityKeys();
    expect(k.publicKeyBytes).toBeInstanceOf(Uint8Array);
  });

  it('throws after resetCrypto', () => {
    resetCrypto();
    expect(() => getIdentityKeys()).toThrow();
  });
});

describe('hasPrekeySecrets', () => {
  it('delegates to manager', () => {
    expect(cryptoService.hasPrekeySecrets()).toBe(true);
    expect(h.managerMock.hasPrekeySecrets).toHaveBeenCalled();
  });
});

describe('generatePrekeyBundle', () => {
  it('returns the bundle and persists sessions', async () => {
    const bundle = await cryptoService.generatePrekeyBundle('dk');
    expect(bundle.identity_key).toBe('A');
  });
});

describe('encryptDM / decryptDM', () => {
  it('ensures pairwise session then encrypts', async () => {
    const ct = await cryptoService.encryptDM('t1', 'peer1', 'hi', 'dm-1', 'dk');
    expect(ct).toContain('ct-dm:peer1:hi');
    expect(h.getPrekeyBundle).toHaveBeenCalledWith('t1', 'peer1', { initiate: true });
    expect(h.managerMock.initSessionWithBundle).toHaveBeenCalled();
    expect(h.managerMock.encryptDM).toHaveBeenCalled();
  });

  it('subsequent encryptDM for same peer skips ensurePeerSession init', async () => {
    await cryptoService.encryptDM('t1', 'peer1', 'first', 'dm-1', 'dk');
    h.managerMock.initSessionWithBundle.mockClear();
    await cryptoService.encryptDM('t1', 'peer1', 'second', 'dm-1', 'dk');
    expect(h.managerMock.initSessionWithBundle).not.toHaveBeenCalled();
  });

  it('decryptDM rountrips', async () => {
    const pt = await cryptoService.decryptDM('t1', 'peer2', 'ciphertext', 'dm-x', 'dk');
    expect(pt).toBe('pt-dm:peer2:ciphertext');
  });

  it('concurrent encryptDM calls share the in-flight session promise', async () => {
    const [a, b] = await Promise.all([
      cryptoService.encryptDM('t1', 'peerX', 'a', 'dm-1', 'dk'),
      cryptoService.encryptDM('t1', 'peerX', 'b', 'dm-1', 'dk'),
    ]);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(h.managerMock.initSessionWithBundle).toHaveBeenCalledTimes(1);
  });
});

describe('wrapForPeer / unwrapFromPeer', () => {
  it('wrapForPeer returns ciphertext via manager.wrapForPeer', async () => {
    const out = await cryptoService.wrapForPeer('t1', 'peer1', new Uint8Array([1, 2]));
    expect(out).toBe('wrapped');
    expect(h.managerMock.wrapForPeer).toHaveBeenCalled();
  });

  it('unwrapFromPeer returns bytes via manager.unwrapFromPeer', async () => {
    const out = await cryptoService.unwrapFromPeer('t1', 'peer1', 'ct');
    expect(out).toBeInstanceOf(Uint8Array);
  });
});

describe('getSafetyNumber', () => {
  it('decodes the peer public key + delegates', async () => {
    const sn = await cryptoService.getSafetyNumber('peer1', 'YQ==', 'dk');
    expect(sn).toBe('sn:peer1');
  });
});

describe('processSenderKey + rotateChannelKey + getSenderKeyDistribution', () => {
  it('processSenderKey persists and forwards to manager', async () => {
    await cryptoService.processSenderKey('ch-1', '{}', 'dk');
    expect(h.managerMock.processSenderKey).toHaveBeenCalled();
  });

  it('rotateChannelKey forwards to manager', async () => {
    await cryptoService.rotateChannelKey('ch-1', 'evicted-user', 'dk');
    expect(h.managerMock.rotateChannelKey).toHaveBeenCalled();
  });

  it('getSenderKeyDistribution returns a JSON string', async () => {
    const dist = await cryptoService.getSenderKeyDistribution('ch-1', 'dk');
    expect(dist).toBe('dist');
  });
});

describe('encryptChannel / decryptChannel', () => {
  it('encryptChannel creates a fresh session and encrypts', async () => {
    const ct = await cryptoService.encryptChannel('ch-x', 'me', 'hi', 'dk');
    expect(ct).toContain('ct-ch:hi');
  });

  it('decryptChannel decrypts', async () => {
    const pt = await cryptoService.decryptChannel('ch-x', 'me', 'sender', 'ct', 'dk');
    expect(pt).toContain('pt-ch:ct');
  });
});
