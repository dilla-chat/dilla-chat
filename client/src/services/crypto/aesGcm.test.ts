import { describe, it, expect } from 'vitest';
import { aesGcmEncrypt, aesGcmDecrypt } from './aesGcm';
import { randomBytes } from './helpers';

describe('aesGcm', () => {
  it('roundtrips a short plaintext', async () => {
    const key = randomBytes(32);
    const pt = new TextEncoder().encode('hello world');
    const ct = await aesGcmEncrypt(key, pt);
    const decrypted = await aesGcmDecrypt(key, ct);
    expect(new TextDecoder().decode(decrypted)).toBe('hello world');
  });

  it('roundtrips empty plaintext (auth tag still present)', async () => {
    const key = randomBytes(32);
    const ct = await aesGcmEncrypt(key, new Uint8Array(0));
    const decrypted = await aesGcmDecrypt(key, ct);
    expect(decrypted.length).toBe(0);
    // 12-byte nonce + 16-byte GCM tag
    expect(ct.length).toBe(28);
  });

  it('ciphertext starts with a 12-byte nonce', async () => {
    const key = randomBytes(32);
    const ct = await aesGcmEncrypt(key, new TextEncoder().encode('x'));
    expect(ct.length).toBeGreaterThanOrEqual(13);
  });

  it('two encryptions of the same plaintext produce different ciphertexts (random nonce)', async () => {
    const key = randomBytes(32);
    const pt = new TextEncoder().encode('same input');
    const ct1 = await aesGcmEncrypt(key, pt);
    const ct2 = await aesGcmEncrypt(key, pt);
    expect(ct1).not.toEqual(ct2);
  });

  it('decrypting with the wrong key throws', async () => {
    const k1 = randomBytes(32);
    const k2 = randomBytes(32);
    const ct = await aesGcmEncrypt(k1, new TextEncoder().encode('secret'));
    await expect(aesGcmDecrypt(k2, ct)).rejects.toBeDefined();
  });

  it('decrypting tampered ciphertext throws (auth tag check)', async () => {
    const key = randomBytes(32);
    const ct = await aesGcmEncrypt(key, new TextEncoder().encode('important'));
    // Flip a bit in the last byte (the auth tag).
    ct[ct.length - 1] ^= 0x01;
    await expect(aesGcmDecrypt(key, ct)).rejects.toBeDefined();
  });

  it('decrypting a buffer shorter than the nonce throws "Ciphertext too short"', async () => {
    const key = randomBytes(32);
    await expect(aesGcmDecrypt(key, new Uint8Array(8))).rejects.toThrow('Ciphertext too short');
  });

  it('roundtrips a 64KiB payload', async () => {
    const key = randomBytes(32);
    const big = randomBytes(64 * 1024);
    const ct = await aesGcmEncrypt(key, big);
    const back = await aesGcmDecrypt(key, ct);
    expect(back.length).toBe(big.length);
    for (let i = 0; i < big.length; i++) expect(back[i]).toBe(big[i]);
  });
});
