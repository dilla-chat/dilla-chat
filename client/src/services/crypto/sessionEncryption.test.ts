import { describe, it, expect } from 'vitest';
import {
  encryptSessionData,
  decryptSessionData,
  passphraseToKey,
} from './sessionEncryption';
import { bytesEqual, randomBytes } from './helpers';

describe('crypto/sessionEncryption', () => {
  it('passphraseToKey is deterministic for the same passphrase+salt', async () => {
    const salt = new Uint8Array(16);
    const a = await passphraseToKey('hunter2', salt);
    const b = await passphraseToKey('hunter2', salt);
    expect(bytesEqual(a, b)).toBe(true);
    expect(a.length).toBe(32);
  });

  it('passphraseToKey: different passphrases produce different keys', async () => {
    const salt = new Uint8Array(16);
    const a = await passphraseToKey('pwA', salt);
    const b = await passphraseToKey('pwB', salt);
    expect(bytesEqual(a, b)).toBe(false);
  });

  it('passphraseToKey: different salts produce different keys', async () => {
    const a = await passphraseToKey('pw', new Uint8Array(16).fill(1));
    const b = await passphraseToKey('pw', new Uint8Array(16).fill(2));
    expect(bytesEqual(a, b)).toBe(false);
  });

  it('roundtrips an object payload', async () => {
    const data = { foo: 'bar', n: 42, arr: [1, 2, 3] };
    const ct = await encryptSessionData(data, 'secret');
    const back = await decryptSessionData(ct, 'secret');
    expect(back).toEqual(data);
  });

  it('prepends a 16-byte salt', async () => {
    const ct = await encryptSessionData({ a: 1 }, 'p');
    // salt 16 + nonce 12 + ciphertext + 16-byte GCM tag → ≥ 28+ bytes
    expect(ct.length).toBeGreaterThanOrEqual(28);
  });

  it('two encryptions of the same payload produce different ciphertexts (random salt)', async () => {
    const a = await encryptSessionData({ same: true }, 'p');
    const b = await encryptSessionData({ same: true }, 'p');
    expect(bytesEqual(a, b)).toBe(false);
  });

  it('decryption with the wrong passphrase throws', async () => {
    const ct = await encryptSessionData({ x: 1 }, 'right');
    await expect(decryptSessionData(ct, 'wrong')).rejects.toBeDefined();
  });

  it('decryption of a too-short buffer throws "Session data too short"', async () => {
    await expect(decryptSessionData(new Uint8Array(8), 'p')).rejects.toThrow('Session data too short');
  });

  it('roundtrips a nested object', async () => {
    const data = { a: { b: { c: [{ d: 'deep' }] } } };
    const ct = await encryptSessionData(data, 'k');
    expect(await decryptSessionData(ct, 'k')).toEqual(data);
  });

  it('tampering with the ciphertext after the salt throws', async () => {
    const ct = await encryptSessionData({ secret: 'x' }, 'p');
    // Skip past the 16-byte salt; flip an inner byte.
    ct[20] ^= 0x80;
    await expect(decryptSessionData(ct, 'p')).rejects.toBeDefined();
  });

  it('different salts in the prefix mean a re-derived key — also fails to decrypt', async () => {
    const ct = await encryptSessionData({ secret: 'x' }, 'p');
    // Mutate the salt portion → decryption rederives the wrong key.
    const salt = randomBytes(16);
    salt.set(ct.slice(0, 16).map((b) => b ^ 0xff));
    const mutated = new Uint8Array(ct);
    mutated.set(salt, 0);
    await expect(decryptSessionData(mutated, 'p')).rejects.toBeDefined();
  });
});
