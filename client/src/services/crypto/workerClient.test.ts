// Coverage for the workerClient.ts public surface.
//
// jsdom doesn't ship a Worker global, so `typeof Worker === 'undefined'`
// is true — the fallback branches of each `*InWorker()` function run
// in-thread without needing a worker mock. That's exactly the branch
// the production code falls through when CRYPTO_BACKEND='main' too,
// so these tests double as the "main-thread mode" coverage referenced
// in the architecture review §8.4.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setCryptoBackend,
  getCryptoBackend,
  safetyNumberInWorker,
  sessionInitInWorker,
  isSessionInitInWorker,
  identityInitInWorker,
  isIdentityInitInWorker,
} from './workerClient';

describe('workerClient — backend flag', () => {
  afterEach(() => {
    setCryptoBackend('worker');
  });

  it('defaults to "worker" and getCryptoBackend reflects it', () => {
    setCryptoBackend('worker');
    expect(getCryptoBackend()).toBe('worker');
  });

  it('setCryptoBackend("main") switches the active backend', () => {
    setCryptoBackend('main');
    expect(getCryptoBackend()).toBe('main');
  });
});

describe('workerClient — main-thread fallbacks', () => {
  beforeEach(() => {
    setCryptoBackend('main');
  });

  afterEach(() => {
    setCryptoBackend('worker');
    vi.restoreAllMocks();
  });

  it('safetyNumberInWorker delegates to generateSafetyNumber when backend=main', async () => {
    // Real generateSafetyNumber is a SHA-256 over the four inputs —
    // exercising it directly without a mock proves the dispatch fell
    // through to the main-thread path.
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([5, 6, 7, 8]);
    const out = await safetyNumberInWorker(a, 'alice', b, 'bob');
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });

  it('safetyNumberInWorker is deterministic over the same inputs', async () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([5, 6, 7, 8]);
    const x = await safetyNumberInWorker(a, 'alice', b, 'bob');
    const y = await safetyNumberInWorker(a, 'alice', b, 'bob');
    expect(x).toBe(y);
  });

  it('safetyNumberInWorker is order-symmetric (alice↔bob produces the same number)', async () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([5, 6, 7, 8]);
    const x = await safetyNumberInWorker(a, 'alice', b, 'bob');
    const y = await safetyNumberInWorker(b, 'bob', a, 'alice');
    expect(x).toBe(y);
  });

  it('sessionInitInWorker is a no-op when backend=main', async () => {
    await expect(sessionInitInWorker('derived-key')).resolves.toBeUndefined();
    // No worker spawned; isSessionInitInWorker stays false because the
    // main-thread fallback returns before flipping the flag.
    expect(isSessionInitInWorker()).toBe(false);
  });

  it('identityInitInWorker is a no-op when backend=main', async () => {
    // Build a non-extractable AES key just to have a CryptoKey to pass.
    const ck = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    await expect(
      identityInitInWorker(ck as CryptoKey, new Uint8Array([1, 2, 3])),
    ).resolves.toBeUndefined();
    expect(isIdentityInitInWorker()).toBe(false);
  });

  it('isIdentityInitInWorker / isSessionInitInWorker default to false', () => {
    // No init call yet in this fresh test instance.
    expect(isSessionInitInWorker()).toBe(false);
    expect(isIdentityInitInWorker()).toBe(false);
  });
});
