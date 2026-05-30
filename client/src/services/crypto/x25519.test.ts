import { describe, it, expect } from 'vitest';
import {
  generateX25519KeyPair,
  x25519DH,
  importX25519PublicKey,
  exportX25519PrivateKey,
  importX25519PrivateKey,
} from './x25519';
import { bytesEqual } from './helpers';

describe('crypto/x25519', () => {
  it('two DH operations with swapped key pairs produce the same shared secret', async () => {
    const alice = await generateX25519KeyPair();
    const bob = await generateX25519KeyPair();
    const aliceSees = await x25519DH(alice.privateKey, bob.publicKeyBytes);
    const bobSees = await x25519DH(bob.privateKey, alice.publicKeyBytes);
    expect(bytesEqual(aliceSees, bobSees)).toBe(true);
  });

  it('shared secret is 32 bytes', async () => {
    const a = await generateX25519KeyPair();
    const b = await generateX25519KeyPair();
    expect((await x25519DH(a.privateKey, b.publicKeyBytes)).length).toBe(32);
  });

  it('different counterparties produce different shared secrets', async () => {
    const me = await generateX25519KeyPair();
    const peer1 = await generateX25519KeyPair();
    const peer2 = await generateX25519KeyPair();
    const s1 = await x25519DH(me.privateKey, peer1.publicKeyBytes);
    const s2 = await x25519DH(me.privateKey, peer2.publicKeyBytes);
    expect(bytesEqual(s1, s2)).toBe(false);
  });

  it('public key roundtrips through raw import', async () => {
    const kp = await generateX25519KeyPair();
    const re = await importX25519PublicKey(kp.publicKeyBytes);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', re));
    expect(bytesEqual(raw, kp.publicKeyBytes)).toBe(true);
  });

  it('private key roundtrips through pkcs8 import/export and still DHs to the same secret', async () => {
    const alice = await generateX25519KeyPair();
    const bob = await generateX25519KeyPair();
    const before = await x25519DH(alice.privateKey, bob.publicKeyBytes);
    const reimported = await importX25519PrivateKey(await exportX25519PrivateKey(alice.privateKey));
    const after = await x25519DH(reimported, bob.publicKeyBytes);
    expect(bytesEqual(before, after)).toBe(true);
  });
});
