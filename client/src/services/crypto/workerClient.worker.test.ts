// Drive workerClient.ts with a stubbed Worker so the RPC call() path
// is exercised (post + correlated response). The existing
// workerClient.test.ts only covers the backend=main fallbacks.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Stub Worker BEFORE importing the module so getWorker() picks it up.
class FakeWorker {
  static instances: FakeWorker[] = [];
  listeners: Map<string, ((_ev: unknown) => void)[]> = new Map();
  lastMessage: unknown = null;
  responseFor: (_msg: { id: number; op: string; payload: unknown }) => unknown = (msg) => {
    // Match return shape per op so callers that wrap into Map work
    if (msg.op.endsWith('.loadAll')) {
      return { id: msg.id, ok: true, result: [] };
    }
    return { id: msg.id, ok: true, result: 'ok' };
  };
  autoReply = true;

  constructor() { FakeWorker.instances.push(this); }

  addEventListener(name: string, fn: (_ev: unknown) => void) {
    const arr = this.listeners.get(name) ?? [];
    arr.push(fn);
    this.listeners.set(name, arr);
  }

  postMessage(msg: { id: number; op: string; payload: unknown }) {
    this.lastMessage = msg;
    if (!this.autoReply) return;
    const reply = this.responseFor(msg);
    queueMicrotask(() => {
      const handlers = this.listeners.get('message') ?? [];
      for (const h of handlers) h({ data: reply });
    });
  }

  terminate() {
    FakeWorker.instances = FakeWorker.instances.filter((i) => i !== this);
  }

  trigger(name: string, ev: unknown) {
    const handlers = this.listeners.get(name) ?? [];
    for (const h of handlers) h(ev);
  }
}

beforeEach(() => {
  FakeWorker.instances = [];
  (globalThis as unknown as { Worker: typeof FakeWorker }).Worker = FakeWorker;
});

afterEach(async () => {
  const wc = await import('./workerClient');
  wc.__resetCryptoWorkerForTests();
  wc.setCryptoBackend('worker');
});

describe('workerClient.ts — call() RPC via mocked Worker', () => {
  it('safetyNumberInWorker postMessages and resolves with worker result', async () => {
    const { safetyNumberInWorker, setCryptoBackend } = await import('./workerClient');
    setCryptoBackend('worker');

    // Override the default response to return a known safety number
    const out = safetyNumberInWorker(
      new Uint8Array([1, 2, 3, 4]), 'me',
      new Uint8Array([5, 6, 7, 8]), 'them',
    );
    // Wait a tick for the FakeWorker to handle postMessage
    await new Promise((r) => setTimeout(r, 0));
    const w = FakeWorker.instances[0];
    expect(w).toBeTruthy();
    expect((w.lastMessage as { op: string }).op).toBe('safetyNumber.compute');
    const result = await out;
    expect(result).toBe('ok');
  });

  it('sessionInitInWorker posts session.init then isSessionInitInWorker becomes true', async () => {
    const { sessionInitInWorker, isSessionInitInWorker, setCryptoBackend } =
      await import('./workerClient');
    setCryptoBackend('worker');
    expect(isSessionInitInWorker()).toBe(false);
    const p = sessionInitInWorker('a'.repeat(64));
    await p;
    expect(isSessionInitInWorker()).toBe(true);
    const w = FakeWorker.instances[0];
    expect((w.lastMessage as { op: string }).op).toBe('session.init');
  });

  it('sessionSaveInWorker / sessionLoadInWorker / sessionDeleteInWorker', async () => {
    const { sessionSaveInWorker, sessionLoadInWorker, sessionDeleteInWorker } =
      await import('./workerClient');
    await sessionSaveInWorker('ch-1', { x: 1 });
    await sessionLoadInWorker('ch-1');
    await sessionDeleteInWorker('ch-1');
    const w = FakeWorker.instances[0];
    expect(w).toBeTruthy();
  });

  it('sessionLoadAllInWorker returns a Map from worker entries', async () => {
    const { sessionLoadAllInWorker } = await import('./workerClient');
    FakeWorker.instances[0] = new FakeWorker();
    FakeWorker.instances[0].responseFor = (m) => ({
      id: m.id, ok: true, result: [['ch-1', { a: 1 }], ['ch-2', { b: 2 }]],
    });
    // Get a worker spawn by calling
    const result = sessionLoadAllInWorker();
    // The FakeWorker that was actually constructed by getWorker is at index 0
    await new Promise((r) => setTimeout(r, 0));
    const w = FakeWorker.instances[FakeWorker.instances.length - 1];
    w.responseFor = (m) => ({
      id: m.id, ok: true, result: [['ch-1', { a: 1 }]],
    });
    const map = await result;
    expect(map instanceof Map).toBe(true);
  });

  it('groupSession encrypt/decrypt/processDistribution/rotateMyKey/getDistribution', async () => {
    const wc = await import('./workerClient');
    await wc.groupSessionEncryptInWorker('ch-1', 'me', 'YWFhYQ==');
    await wc.groupSessionDecryptInWorker('ch-1', 'YWFhYQ==');
    await wc.groupSessionProcessDistributionInWorker('ch-1', 'me', '{"k":"v"}');
    await wc.groupSessionRotateMyKeyInWorker('ch-1', 'evicted-user');
    await wc.groupSessionGetDistributionInWorker('ch-1', 'me');
    expect(FakeWorker.instances.length).toBeGreaterThan(0);
  });

  it('pairwiseSession save/load/delete/loadAll/encrypt/decrypt', async () => {
    const wc = await import('./workerClient');
    await wc.pairwiseSessionSaveInWorker('peer1', { ratchet: 'x' });
    await wc.pairwiseSessionLoadInWorker('peer1');
    await wc.pairwiseSessionDeleteInWorker('peer1');
    await wc.pairwiseSessionLoadAllInWorker();
    await wc.pairwiseSessionEncryptInWorker('peer1', 'YWFhYQ==');
    await wc.pairwiseSessionDecryptInWorker('peer1', 'YWFhYQ==');
    expect(FakeWorker.instances.length).toBeGreaterThan(0);
  });

  it('identityInitInWorker is idempotent across multiple calls', async () => {
    const { identityInitInWorker, isIdentityInitInWorker, setCryptoBackend } =
      await import('./workerClient');
    setCryptoBackend('worker');
    expect(isIdentityInitInWorker()).toBe(false);
    // Make a CryptoKey stand-in
    const fakeKey = {} as CryptoKey;
    await identityInitInWorker(fakeKey, new Uint8Array([1, 2, 3]));
    expect(isIdentityInitInWorker()).toBe(true);
    // Calling again is idempotent (no second postMessage)
    const w = FakeWorker.instances[0];
    const before = w.listeners.size;
    await identityInitInWorker(fakeKey);
    expect(w.listeners.size).toBe(before);
  });

  it('wrapForPeerInWorker / unwrapFromPeerInWorker', async () => {
    const wc = await import('./workerClient');
    const peerPub = new Uint8Array([9, 9, 9, 9]);
    await wc.wrapForPeerInWorker(peerPub, new Uint8Array([1, 2, 3]));
    // Configure response for unwrap to return a base64 plaintext
    const w = FakeWorker.instances[FakeWorker.instances.length - 1];
    w.responseFor = (m) => ({ id: m.id, ok: true, result: 'YWFhYQ==' });
    const out = await wc.unwrapFromPeerInWorker(peerPub, new Uint8Array([4, 5, 6]));
    expect(out).toBeInstanceOf(Uint8Array);
  });

  it('prekeyVaultSaveInWorker / prekeyVaultClearInWorker', async () => {
    const wc = await import('./workerClient');
    await wc.prekeyVaultSaveInWorker(new Uint8Array([1, 2, 3]), [
      new Uint8Array([4, 5]), new Uint8Array([6, 7]),
    ]);
    await wc.prekeyVaultClearInWorker();
    expect(FakeWorker.instances.length).toBeGreaterThan(0);
  });

  it('bootstrapAlice / bootstrapBob', async () => {
    const wc = await import('./workerClient');
    const bundle = { identity_key: 'abc', signed_prekey: 'def' };
    // Configure alice response
    setTimeout(() => {
      const w = FakeWorker.instances[FakeWorker.instances.length - 1];
      if (w) w.responseFor = (m) => ({
        id: m.id, ok: true, result: { identity_dh_key: [1], ephemeral_key: [2], one_time_prekey_index: 0 },
      });
    }, 0);
    const out = await wc.pairwiseSessionBootstrapAliceInWorker('peer1', bundle);
    expect(out).toBeTruthy();
    await wc.pairwiseSessionBootstrapBobInWorker('peer1', out);
  });

  it('worker error path rejects pending calls', async () => {
    // Pre-spawn a non-auto-replying worker by hand-spawning via a call
    const wc = await import('./workerClient');
    // Force the next-created worker to NOT auto-reply
    const origCtor = (globalThis as { Worker: typeof FakeWorker }).Worker;
    class NoReplyWorker extends FakeWorker { autoReply = false; }
    (globalThis as { Worker: typeof FakeWorker }).Worker = NoReplyWorker as never;
    const p = wc.sessionSaveInWorker('ch-x', { x: 1 });
    // Restore for safety; trigger error on the spawned worker
    (globalThis as { Worker: typeof FakeWorker }).Worker = origCtor;
    const w = FakeWorker.instances[FakeWorker.instances.length - 1];
    w.trigger('error', { message: 'boom' });
    await expect(p).rejects.toThrow();
  });

  it('__resetCryptoWorkerForTests terminates the worker and rejects pending calls', async () => {
    const wc = await import('./workerClient');
    // Force a non-auto-reply worker so the call stays pending until reset
    const origCtor = (globalThis as { Worker: typeof FakeWorker }).Worker;
    class NoReplyWorker extends FakeWorker { autoReply = false; }
    (globalThis as { Worker: typeof FakeWorker }).Worker = NoReplyWorker as never;
    const p = wc.sessionLoadInWorker('ch-y');
    (globalThis as { Worker: typeof FakeWorker }).Worker = origCtor;
    wc.__resetCryptoWorkerForTests();
    await expect(p).rejects.toThrow();
  });
});
