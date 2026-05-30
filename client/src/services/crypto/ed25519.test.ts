import { describe, it, expect } from 'vitest';
import {
  generateEd25519KeyPair,
  ed25519Sign,
  ed25519Verify,
  importEd25519PublicKey,
  exportEd25519PrivateKey,
  importEd25519PrivateKey,
} from './ed25519';

describe('crypto/ed25519', () => {
  it('signature verifies with the matching public key', async () => {
    const kp = await generateEd25519KeyPair();
    const msg = new TextEncoder().encode('hello signal');
    const sig = await ed25519Sign(kp.privateKey, msg);
    expect(await ed25519Verify(kp.publicKey, sig, msg)).toBe(true);
  });

  it('signature fails to verify under a different keypair', async () => {
    const a = await generateEd25519KeyPair();
    const b = await generateEd25519KeyPair();
    const msg = new TextEncoder().encode('cross-key');
    const sig = await ed25519Sign(a.privateKey, msg);
    expect(await ed25519Verify(b.publicKey, sig, msg)).toBe(false);
  });

  it('signature fails to verify when the message is tampered', async () => {
    const kp = await generateEd25519KeyPair();
    const msg = new TextEncoder().encode('original');
    const sig = await ed25519Sign(kp.privateKey, msg);
    const tampered = new TextEncoder().encode('original!');
    expect(await ed25519Verify(kp.publicKey, sig, tampered)).toBe(false);
  });

  it('exports a 32-byte raw public key', async () => {
    const kp = await generateEd25519KeyPair();
    expect(kp.publicKeyBytes.length).toBe(32);
  });

  it('public key roundtrips through raw import/export', async () => {
    const kp = await generateEd25519KeyPair();
    const reimported = await importEd25519PublicKey(kp.publicKeyBytes);
    const sig = await ed25519Sign(kp.privateKey, new TextEncoder().encode('x'));
    expect(await ed25519Verify(reimported, sig, new TextEncoder().encode('x'))).toBe(true);
  });

  it('private key roundtrips through pkcs8 import/export', async () => {
    const kp = await generateEd25519KeyPair();
    const pkcs8 = await exportEd25519PrivateKey(kp.privateKey);
    const reimported = await importEd25519PrivateKey(pkcs8);
    const sig = await ed25519Sign(reimported, new TextEncoder().encode('roundtrip'));
    expect(await ed25519Verify(kp.publicKey, sig, new TextEncoder().encode('roundtrip'))).toBe(true);
  });
});
