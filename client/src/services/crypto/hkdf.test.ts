import { describe, it, expect } from 'vitest';
import { hkdfDerive, kdfRoot, kdfChain } from './hkdf';
import { randomBytes, bytesEqual } from './helpers';

describe('crypto/hkdf', () => {
  it('hkdfDerive: deterministic for the same inputs', async () => {
    const ikm = new TextEncoder().encode('input-key-material');
    const info = new TextEncoder().encode('context');
    const a = await hkdfDerive(ikm, info, 32);
    const b = await hkdfDerive(ikm, info, 32);
    expect(bytesEqual(a, b)).toBe(true);
  });

  it('hkdfDerive: salt changes the output', async () => {
    const ikm = randomBytes(32);
    const info = new Uint8Array([0]);
    const a = await hkdfDerive(ikm, info, 32);
    const b = await hkdfDerive(ikm, info, 32, randomBytes(16));
    expect(bytesEqual(a, b)).toBe(false);
  });

  it('hkdfDerive: respects the requested length', async () => {
    const ikm = randomBytes(32);
    expect((await hkdfDerive(ikm, new Uint8Array(0), 16)).length).toBe(16);
    expect((await hkdfDerive(ikm, new Uint8Array(0), 64)).length).toBe(64);
  });

  it('kdfRoot: returns a [rootKey, chainKey] pair of 32+32 bytes', async () => {
    const [next, chain] = await kdfRoot(randomBytes(32), randomBytes(32));
    expect(next.length).toBe(32);
    expect(chain.length).toBe(32);
    expect(bytesEqual(next, chain)).toBe(false);
  });

  it('kdfRoot: deterministic for the same root+dh inputs', async () => {
    const root = randomBytes(32);
    const dh = randomBytes(32);
    const a = await kdfRoot(root, dh);
    const b = await kdfRoot(root, dh);
    expect(bytesEqual(a[0], b[0])).toBe(true);
    expect(bytesEqual(a[1], b[1])).toBe(true);
  });

  it('kdfChain: returns a [nextChain, messageKey] pair of 32+32 bytes', async () => {
    const [next, msg] = await kdfChain(randomBytes(32));
    expect(next.length).toBe(32);
    expect(msg.length).toBe(32);
    expect(bytesEqual(next, msg)).toBe(false);
  });

  it('kdfChain: deterministic for the same chain key', async () => {
    const ck = randomBytes(32);
    const a = await kdfChain(ck);
    const b = await kdfChain(ck);
    expect(bytesEqual(a[0], b[0])).toBe(true);
    expect(bytesEqual(a[1], b[1])).toBe(true);
  });

  it('kdfChain: domain-separated message vs next-chain keys (HMAC with 0x01 vs 0x02)', async () => {
    // The implementation uses HMAC(ck, 0x01) for the message key and
    // HMAC(ck, 0x02) for the next chain key — they must NEVER coincide.
    const ck = randomBytes(32);
    const [next, msg] = await kdfChain(ck);
    expect(bytesEqual(next, msg)).toBe(false);
  });
});
