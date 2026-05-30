// Cover the worker-backed branches of CryptoManager (encryptDM/decryptDM/
// encryptChannel/decryptChannel/wrapForPeer/unwrapFromPeer/rotate/process/
// getSafetyNumber + ensureIdentity / ensurePrekeyVault + bootstrap paths).

import { describe, it, expect, beforeEach, vi } from 'vitest';

const workerMock = vi.hoisted(() => ({
  getCryptoBackend: vi.fn(() => 'worker'),
  isIdentityInitInWorker: vi.fn(() => false),
  identityInitInWorker: vi.fn(async () => {}),
  safetyNumberInWorker: vi.fn(async () => 'safety-from-worker'),
  groupSessionEncryptInWorker: vi.fn(async () => 'gs-enc'),
  groupSessionDecryptInWorker: vi.fn(async () => btoa('hello-from-group')),
  groupSessionProcessDistributionInWorker: vi.fn(async () => {}),
  groupSessionRotateMyKeyInWorker: vi.fn(async () => 'rotation-dist'),
  groupSessionGetDistributionInWorker: vi.fn(async () => 'dist'),
  pairwiseSessionSaveInWorker: vi.fn(async () => {}),
  pairwiseSessionEncryptInWorker: vi.fn(async () => 'ps-enc'),
  pairwiseSessionDecryptInWorker: vi.fn(async () => ({ ok: true, plaintextB64: btoa('hi') })),
  wrapForPeerInWorker: vi.fn(async () => 'wrapped-b64'),
  unwrapFromPeerInWorker: vi.fn(async () => new Uint8Array([1, 2, 3])),
  prekeyVaultSaveInWorker: vi.fn(async () => {}),
  pairwiseSessionBootstrapAliceInWorker: vi.fn(async () => ({})),
  pairwiseSessionBootstrapBobInWorker: vi.fn(async () => {}),
}));
vi.mock('./workerClient', () => workerMock);

// jsdom lacks Worker — useWorkerGroupSession() ANDs on `typeof Worker !== 'undefined'`.
class WorkerStub { postMessage() {} addEventListener() {} terminate() {} }
(globalThis as unknown as { Worker: typeof WorkerStub }).Worker = WorkerStub;

import { CryptoManager } from './cryptoManager';

async function makeManager() {
  const signing = await crypto.subtle.generateKey({ name: 'Ed25519' as never }, true, ['sign', 'verify']);
  const sk = (signing as CryptoKeyPair).privateKey;
  const skPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', (signing as CryptoKeyPair).publicKey));
  const dh = await crypto.subtle.generateKey('X25519' as never, true, ['deriveBits']);
  const dhPair = dh as CryptoKeyPair;
  const dhPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', dhPair.publicKey));
  return new CryptoManager(sk, skPubRaw, { privateKey: dhPair.privateKey, publicKeyBytes: dhPubRaw });
}

beforeEach(() => {
  Object.values(workerMock).forEach((f) => 'mockClear' in f && (f as { mockClear: () => void }).mockClear());
  workerMock.getCryptoBackend.mockReturnValue('worker');
  workerMock.isIdentityInitInWorker.mockReturnValue(false);
});

describe('CryptoManager — worker paths', () => {
  it('encryptChannel routes through groupSessionEncryptInWorker', async () => {
    const mgr = await makeManager();
    const out = await mgr.encryptChannel('ch-1', 'me', 'hello');
    expect(out).toBe('gs-enc');
    expect(workerMock.groupSessionEncryptInWorker).toHaveBeenCalled();
  });

  it('decryptChannel routes through groupSessionDecryptInWorker', async () => {
    const mgr = await makeManager();
    const out = await mgr.decryptChannel('ch-1', 'me', 'ignored');
    expect(out).toBe('hello-from-group');
    expect(workerMock.groupSessionDecryptInWorker).toHaveBeenCalled();
  });

  it('rotateChannelKey routes through worker', async () => {
    const mgr = await makeManager();
    const out = await mgr.rotateChannelKey('ch-1', 'peer-2');
    expect(out).toBe('rotation-dist');
  });

  it('processSenderKey routes through worker', async () => {
    const mgr = await makeManager();
    await mgr.processSenderKey('ch-1', '{}');
    expect(workerMock.groupSessionProcessDistributionInWorker).toHaveBeenCalled();
  });

  it('getSenderKeyDistribution routes through worker', async () => {
    const mgr = await makeManager();
    const out = await mgr.getSenderKeyDistribution('ch-1', 'me');
    expect(out).toBe('dist');
  });

  it('encryptDM routes through worker', async () => {
    const mgr = await makeManager();
    const out = await mgr.encryptDM('peer1', 'hello');
    expect(out).toBe('ps-enc');
  });

  it('encryptDM fallback throws if no main-thread session and worker errors', async () => {
    workerMock.pairwiseSessionEncryptInWorker.mockRejectedValueOnce(new Error('no session'));
    const mgr = await makeManager();
    await expect(mgr.encryptDM('peer1', 'hello')).rejects.toThrow();
  });

  it('decryptDM returns plaintext from worker', async () => {
    const mgr = await makeManager();
    const out = await mgr.decryptDM('peer1', btoa(JSON.stringify({ header: {}, ciphertext: [] })));
    expect(out).toBe('hi');
  });

  it('decryptDM with needsBootstrap + x3dh runs Bob bootstrap and retries', async () => {
    workerMock.pairwiseSessionDecryptInWorker
      .mockResolvedValueOnce({ ok: false, needsBootstrap: true })
      .mockResolvedValueOnce({ ok: true, plaintextB64: btoa('after') });
    workerMock.isIdentityInitInWorker.mockReturnValue(true);
    const mgr = await makeManager();
    mgr.setPrekeySecrets({
      signed_prekey_private: new Uint8Array(32),
      one_time_prekey_privates: [new Uint8Array(32)],
      identity_dh_private: new Uint8Array(32),
    });
    const wire = btoa(JSON.stringify({ header: { x3dh: { identity_dh_key: [1], ephemeral_key: [2], one_time_prekey_index: 0 } }, ciphertext: [] }));
    const out = await mgr.decryptDM('peer1', wire);
    expect(out).toBe('after');
    expect(workerMock.pairwiseSessionBootstrapBobInWorker).toHaveBeenCalled();
  });

  it('decryptDM falls back to main-thread when worker decrypt throws + no x3dh', async () => {
    workerMock.pairwiseSessionDecryptInWorker.mockRejectedValueOnce(new Error('bad'));
    const mgr = await makeManager();
    const wire = btoa(JSON.stringify({ header: {}, ciphertext: [] }));
    await expect(mgr.decryptDM('peer1', wire)).rejects.toThrow();
  });

  it('wrapForPeer routes through worker after ensureIdentityInWorker', async () => {
    workerMock.isIdentityInitInWorker.mockReturnValueOnce(false).mockReturnValueOnce(true);
    const mgr = await makeManager();
    const out = await mgr.wrapForPeer(new Uint8Array(32), new Uint8Array([1, 2]));
    expect(out).toBe('wrapped-b64');
    expect(workerMock.identityInitInWorker).toHaveBeenCalled();
  });

  it('unwrapFromPeer routes through worker after ensureIdentityInWorker', async () => {
    workerMock.isIdentityInitInWorker.mockReturnValue(true);
    const mgr = await makeManager();
    const out = await mgr.unwrapFromPeer(new Uint8Array(32), btoa('x'));
    expect(out).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('wrapForPeer skips worker when ensureIdentityInWorker fails', async () => {
    workerMock.identityInitInWorker.mockRejectedValueOnce(new Error('boom'));
    workerMock.isIdentityInitInWorker.mockReturnValue(false);
    const mgr = await makeManager();
    // ensureIdentityInWorker returns false → falls through to in-thread x25519
    // which fails on our zero-bytes pubkey, that's fine — we only need to cover
    // the false branch of ensureIdentityInWorker.
    await expect(mgr.wrapForPeer(new Uint8Array(32), new Uint8Array([1]))).rejects.toThrow();
    expect(workerMock.wrapForPeerInWorker).not.toHaveBeenCalled();
  });

  it('getSafetyNumber prefers worker', async () => {
    const mgr = await makeManager();
    const out = await mgr.getSafetyNumber('peer1', new Uint8Array(32));
    expect(out).toBe('safety-from-worker');
  });

  it('getSafetyNumber falls back when worker throws', async () => {
    workerMock.safetyNumberInWorker.mockRejectedValueOnce(new Error('worker dead'));
    const mgr = await makeManager();
    const out = await mgr.getSafetyNumber('peer1', new Uint8Array(32));
    expect(typeof out).toBe('string');
  });

  it('initSessionWithBundle ships through worker when ensureIdentity succeeds', async () => {
    workerMock.isIdentityInitInWorker.mockReturnValueOnce(false).mockReturnValueOnce(true);
    const mgr = await makeManager();
    const bundle = {
      signed_prekey: new Uint8Array(32),
      identity_key: new Uint8Array(32),
      identity_dh_key: new Uint8Array(32),
      signed_prekey_signature: new Uint8Array(64),
      one_time_prekeys: [],
    } as never;
    await mgr.initSessionWithBundle('peer1', bundle);
    expect(workerMock.pairwiseSessionBootstrapAliceInWorker).toHaveBeenCalled();
  });

  it('initSessionWithBundle returns early when session already exists', async () => {
    workerMock.isIdentityInitInWorker.mockReturnValueOnce(true);
    const mgr = await makeManager();
    const bundle = { signed_prekey: new Uint8Array(32), identity_dh_key: new Uint8Array(32), one_time_prekeys: [] } as never;
    await mgr.initSessionWithBundle('peer1', bundle); // creates worker-side
    // Now mark in-memory session existing
    (mgr as unknown as { pairwiseSessions: Map<string, unknown> }).pairwiseSessions.set('peer1', {} as never);
    workerMock.pairwiseSessionBootstrapAliceInWorker.mockClear();
    await mgr.initSessionWithBundle('peer1', bundle);
    expect(workerMock.pairwiseSessionBootstrapAliceInWorker).not.toHaveBeenCalled();
  });

  it('loadSessions populates groupSessions', async () => {
    const mgr = await makeManager();
    // Use a real GroupSession via createDistributionMessage
    const { GroupSession } = await import('./groupSession');
    const session = await GroupSession.create('ch-1', 'me');
    const data = { version: CryptoManager.SESSION_FORMAT_VERSION, groupSessions: { 'ch-1': session.toJSON() } };
    mgr.loadSessions(data as never);
    expect(mgr.groupSessions.has('ch-1')).toBe(true);
  });
});
