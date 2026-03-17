import { describe, it, expect } from 'vitest';
import {
  toBase64,
  fromBase64,
  concatBytes,
  aesGcmEncrypt,
  aesGcmDecrypt,
  hkdfDerive,
  randomBytes,
} from './cryptoCore';

describe('toBase64 / fromBase64', () => {
  it('roundtrips correctly', () => {
    const data = new Uint8Array([0, 1, 2, 128, 255]);
    const b64 = toBase64(data);
    const decoded = fromBase64(b64);
    expect(decoded).toEqual(data);
  });

  it('handles empty array', () => {
    const data = new Uint8Array(0);
    expect(fromBase64(toBase64(data))).toEqual(data);
  });
});

describe('concatBytes', () => {
  it('concatenates multiple arrays', () => {
    const a = new Uint8Array([1, 2]);
    const b = new Uint8Array([3, 4, 5]);
    const c = new Uint8Array([6]);
    const result = concatBytes(a, b, c);
    expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
  });

  it('handles empty arrays', () => {
    const result = concatBytes(new Uint8Array(0), new Uint8Array([1]));
    expect(result).toEqual(new Uint8Array([1]));
  });
});

describe('AES-GCM encrypt/decrypt', () => {
  it('roundtrips correctly', async () => {
    const key = randomBytes(32);
    const plaintext = new TextEncoder().encode('Hello, Dilla!');
    const ciphertext = await aesGcmEncrypt(key, plaintext);
    expect(ciphertext.length).toBeGreaterThan(plaintext.length); // nonce + ciphertext + tag
    const decrypted = await aesGcmDecrypt(key, ciphertext);
    expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
  });

  it('rejects tampered ciphertext', async () => {
    const key = randomBytes(32);
    const plaintext = new TextEncoder().encode('secret');
    const ciphertext = await aesGcmEncrypt(key, plaintext);
    ciphertext[ciphertext.length - 1] ^= 0xff; // tamper
    await expect(aesGcmDecrypt(key, ciphertext)).rejects.toThrow();
  });

  it('rejects too-short ciphertext', async () => {
    const key = randomBytes(32);
    await expect(aesGcmDecrypt(key, new Uint8Array(5))).rejects.toThrow('Ciphertext too short');
  });
});

describe('HKDF', () => {
  it('derives a key of requested length', async () => {
    const ikm = randomBytes(32);
    const info = new TextEncoder().encode('test');
    const derived = await hkdfDerive(ikm, info, 32);
    expect(derived.length).toBe(32);
  });

  it('produces different output for different info', async () => {
    const ikm = randomBytes(32);
    const d1 = await hkdfDerive(ikm, new TextEncoder().encode('info1'), 32);
    const d2 = await hkdfDerive(ikm, new TextEncoder().encode('info2'), 32);
    expect(d1).not.toEqual(d2);
  });
});
