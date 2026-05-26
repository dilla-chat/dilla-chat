// Cover the worker.ts dispatch switch by sending RpcRequests through the
// `self.addEventListener('message')` handler. Because worker.ts uses
// `self` directly, we shim it as globalThis in jsdom.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// All deep impl modules mocked so dispatch() executes without real crypto.
vi.mock('./safetyNumbers', () => ({ generateSafetyNumber: vi.fn(async () => 'safety-number-123') }));
vi.mock('./sessionStoreWorkerImpl', () => ({
  initSessionKey: vi.fn(async () => {}),
  resetSessionKey: vi.fn(),
  saveSession: vi.fn(async () => {}),
  loadSession: vi.fn(async () => null),
  loadAllSessions: vi.fn(async () => []),
  deleteSession: vi.fn(async () => {}),
}));
vi.mock('./groupSessionWorkerImpl', () => ({
  opEncrypt: vi.fn(async () => 'gs-enc'),
  opDecrypt: vi.fn(async () => 'gs-dec'),
  opProcessDistribution: vi.fn(async () => {}),
  opRotateMyKey: vi.fn(async () => 'gs-rot'),
  opGetDistribution: vi.fn(async () => 'gs-dist'),
}));
vi.mock('./pairwiseSessionStoreWorkerImpl', () => ({
  savePairwiseSession: vi.fn(async () => {}),
  loadPairwiseSession: vi.fn(async () => null),
  loadAllPairwiseSessions: vi.fn(async () => []),
  deletePairwiseSession: vi.fn(async () => {}),
}));
vi.mock('./pairwiseSessionWorkerImpl', () => ({
  opPairwiseEncrypt: vi.fn(async () => 'ps-enc'),
  opPairwiseDecrypt: vi.fn(async () => ({ ok: true, plaintextB64: 'pt' })),
  opPairwiseBootstrapAlice: vi.fn(async () => ({ identity_dh_key: [1], ephemeral_key: [2], one_time_prekey_index: 0 })),
  opPairwiseBootstrapBob: vi.fn(async () => {}),
}));
vi.mock('./identityWorkerImpl', () => ({
  setIdentityDhPrivateKey: vi.fn(),
  setIdentityDhPublicKeyBytes: vi.fn(),
  hasIdentityDhPrivateKey: vi.fn(() => true),
  opWrapForPeer: vi.fn(async () => 'wrapped'),
  opUnwrapFromPeer: vi.fn(async () => 'unwrapped'),
}));
vi.mock('./prekeyVaultWorkerImpl', () => ({
  savePrekeySecrets: vi.fn(async () => {}),
  clearPrekeyVault: vi.fn(async () => {}),
}));
vi.mock('./helpers', () => ({
  fromBase64: (s: string) => new Uint8Array(atob(s).split('').map((c) => c.charCodeAt(0))),
}));

const postedMessages: { data: unknown }[] = [];

// Shim `self.addEventListener` and `self.postMessage` so the worker's
// top-level code can register handlers in jsdom's global scope.
const listeners: Record<string, ((ev: { data: unknown }) => void)[]> = {};
beforeEach(() => {
  postedMessages.length = 0;
  for (const k of Object.keys(listeners)) delete listeners[k];
  (globalThis as unknown as { addEventListener: typeof addEventListener }).addEventListener = ((type: string, cb: (ev: { data: unknown }) => void) => {
    (listeners[type] = listeners[type] ?? []).push(cb);
  }) as typeof addEventListener;
  (globalThis as unknown as { postMessage: (m: unknown) => void }).postMessage = (m: unknown) => {
    postedMessages.push({ data: m });
  };
});

async function dispatchOp(op: string, payload: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  // Fresh-import the worker each time so it re-registers the listener
  // against our globalThis shim.
  vi.resetModules();
  await import('./worker');
  const cb = listeners.message?.[0];
  if (!cb) throw new Error('worker did not register a message listener');
  await cb({ data: { id: 1, op, payload } });
  // Wait microtask
  await new Promise((r) => setTimeout(r, 0));
  const last = postedMessages.at(-1)?.data as { ok: boolean; result?: unknown; error?: string } | undefined;
  return last ?? { ok: false, error: 'no response' };
}

describe('worker.ts dispatch', () => {
  for (const [op, payload] of [
    ['safetyNumber.compute', { ourIdentityKey: btoa('a'), ourId: 'me', theirIdentityKey: btoa('b'), theirId: 'them' }],
    ['session.init', { derivedKey: 'k' }],
    ['session.reset', {}],
    ['session.save', { channelId: 'ch-1', sessionJson: { x: 1 } }],
    ['session.load', { channelId: 'ch-1' }],
    ['session.loadAll', {}],
    ['session.delete', { channelId: 'ch-1' }],
    ['groupSession.encrypt', { channelId: 'ch-1', senderId: 'me', plaintextB64: 'aGk=' }],
    ['groupSession.decrypt', { channelId: 'ch-1', ciphertextB64: 'aGk=' }],
    ['groupSession.processDistribution', { channelId: 'ch-1', ownSenderId: 'me', distributionJson: '{}' }],
    ['groupSession.rotateMyKey', { channelId: 'ch-1', removedUserId: 'u2' }],
    ['groupSession.getDistribution', { channelId: 'ch-1', senderId: 'me' }],
    ['pairwiseSession.save', { peerId: 'p1', sessionJson: { x: 1 } }],
    ['pairwiseSession.load', { peerId: 'p1' }],
    ['pairwiseSession.loadAll', {}],
    ['pairwiseSession.delete', { peerId: 'p1' }],
    ['pairwiseSession.encrypt', { peerId: 'p1', plaintextB64: 'aGk=' }],
    ['pairwiseSession.decrypt', { peerId: 'p1', ciphertextB64: 'aGk=' }],
    ['identity.init', { identityDhPrivateKey: null, identityDhPublicKeyB64: btoa('xyz') }],
    ['identity.init', { identityDhPrivateKey: null }],
    ['identity.hasKey', {}],
    ['identity.wrapForPeer', { peerIdentityDhPubB64: 'a', plaintextB64: 'b' }],
    ['identity.unwrapFromPeer', { peerIdentityDhPubB64: 'a', ciphertextB64: 'b' }],
    ['prekeyVault.save', { signedPrekeyPrivateB64: 'a', oneTimePrekeyPrivatesB64: ['b'] }],
    ['prekeyVault.clear', {}],
    ['pairwiseSession.bootstrapAlice', { peerId: 'p1', peerBundle: {} }],
    ['pairwiseSession.bootstrapBob', { peerId: 'p1', bootstrap: { identity_dh_key: [], ephemeral_key: [], one_time_prekey_index: null } }],
    ['ping', {}],
  ] as const) {
    it(`dispatches ${op}`, async () => {
      const out = await dispatchOp(op, payload);
      expect(out.ok).toBe(true);
    });
  }

  it('unknown op returns error', async () => {
    const out = await dispatchOp('unknown.op', {});
    expect(out.ok).toBe(false);
    expect(out.error).toContain('unknown op');
  });

  it('errors are caught and reported', async () => {
    const out = await dispatchOp('safetyNumber.compute', { ourIdentityKey: 'not-base64!', ourId: 'me', theirIdentityKey: 'b', theirId: 'them' });
    expect(out.ok).toBe(false);
    expect(out.error).toBeTruthy();
  });
});
