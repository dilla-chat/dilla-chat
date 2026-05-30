// H-12d.1 identity-DH wrap/unwrap coverage.
//
// Exercises both the cached-key setters and the wrap/unwrap ops over
// real X25519 keys. Two parallel "users" (alice + bob) bootstrap their
// own identity, then alice wraps a payload for bob's public key, and
// bob's identity unwraps it. Round-trip equality is the contract.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  setIdentityDhPrivateKey,
  setIdentityDhPublicKeyBytes,
  hasIdentityDhPrivateKey,
  getIdentityDhPrivateKey,
  getIdentityDhPublicKeyBytes,
  opWrapForPeer,
  opUnwrapFromPeer,
} from './identityWorkerImpl';
import { generateX25519KeyPair } from './x25519';
import { toBase64, fromBase64 } from './helpers';

describe('identityWorkerImpl — cached key getters/setters', () => {
  beforeEach(() => {
    setIdentityDhPrivateKey(null);
    setIdentityDhPublicKeyBytes(null);
  });

  it('hasIdentityDhPrivateKey is false on cold start', () => {
    expect(hasIdentityDhPrivateKey()).toBe(false);
  });

  it('setIdentityDhPrivateKey + has flips to true', async () => {
    const kp = await generateX25519KeyPair();
    setIdentityDhPrivateKey(kp.privateKey);
    expect(hasIdentityDhPrivateKey()).toBe(true);
    expect(getIdentityDhPrivateKey()).toBe(kp.privateKey);
  });

  it('clearing back to null flips hasIdentity back to false', async () => {
    const kp = await generateX25519KeyPair();
    setIdentityDhPrivateKey(kp.privateKey);
    setIdentityDhPrivateKey(null);
    expect(hasIdentityDhPrivateKey()).toBe(false);
    expect(getIdentityDhPrivateKey()).toBeNull();
  });

  it('setIdentityDhPublicKeyBytes clones the input (no aliasing)', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    setIdentityDhPublicKeyBytes(bytes);
    bytes[0] = 99;
    const cached = getIdentityDhPublicKeyBytes();
    expect(cached![0]).toBe(1);
  });

  it('setIdentityDhPublicKeyBytes(null) clears the cache', () => {
    setIdentityDhPublicKeyBytes(new Uint8Array([1]));
    setIdentityDhPublicKeyBytes(null);
    expect(getIdentityDhPublicKeyBytes()).toBeNull();
  });
});

describe('identityWorkerImpl — wrap/unwrap roundtrip', () => {
  beforeEach(() => {
    setIdentityDhPrivateKey(null);
    setIdentityDhPublicKeyBytes(null);
  });

  it('opWrapForPeer throws when no identity DH key is installed', async () => {
    await expect(opWrapForPeer('AAAA', 'AAAA')).rejects.toThrow(
      /not initialised/i,
    );
  });

  it('opUnwrapFromPeer throws when no identity DH key is installed', async () => {
    await expect(opUnwrapFromPeer('AAAA', 'AAAA')).rejects.toThrow(
      /not initialised/i,
    );
  });

  it('alice wraps for bob → bob unwraps the same plaintext', async () => {
    const alice = await generateX25519KeyPair();
    const bob = await generateX25519KeyPair();
    const plaintext = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const plaintextB64 = toBase64(plaintext);

    // Alice: install her private, wrap for bob.
    setIdentityDhPrivateKey(alice.privateKey);
    const ctB64 = await opWrapForPeer(toBase64(bob.publicKeyBytes), plaintextB64);
    expect(ctB64).toBeTypeOf('string');
    expect(ctB64.length).toBeGreaterThan(0);

    // Bob: install his private, unwrap the ciphertext using alice's pub.
    setIdentityDhPrivateKey(bob.privateKey);
    const recoveredB64 = await opUnwrapFromPeer(toBase64(alice.publicKeyBytes), ctB64);
    expect(Array.from(fromBase64(recoveredB64))).toEqual(Array.from(plaintext));
  });

  it('opUnwrapFromPeer fails with the wrong sender public key', async () => {
    const alice = await generateX25519KeyPair();
    const bob = await generateX25519KeyPair();
    const eve = await generateX25519KeyPair();
    const plaintextB64 = toBase64(new Uint8Array([42]));

    setIdentityDhPrivateKey(alice.privateKey);
    const ctB64 = await opWrapForPeer(toBase64(bob.publicKeyBytes), plaintextB64);

    setIdentityDhPrivateKey(bob.privateKey);
    // Substituting eve's pub for alice's makes the HKDF-derived wrap
    // key wrong → AES-GCM auth tag fails.
    await expect(
      opUnwrapFromPeer(toBase64(eve.publicKeyBytes), ctB64),
    ).rejects.toThrow();
  });

  it('opWrapForPeer is non-deterministic over repeated calls (random IV)', async () => {
    const alice = await generateX25519KeyPair();
    const bob = await generateX25519KeyPair();
    const plaintextB64 = toBase64(new Uint8Array([7, 7, 7]));

    setIdentityDhPrivateKey(alice.privateKey);
    const a = await opWrapForPeer(toBase64(bob.publicKeyBytes), plaintextB64);
    const b = await opWrapForPeer(toBase64(bob.publicKeyBytes), plaintextB64);
    expect(a).not.toEqual(b);
  });
});
