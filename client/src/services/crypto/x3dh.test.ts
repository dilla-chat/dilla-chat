import { describe, it, expect } from 'vitest';
import { x3dhInitiate, x3dhRespond } from './x3dh';
import { generatePrekeyBundle } from './prekeys';
import { generateEd25519KeyPair } from './ed25519';
import { generateX25519KeyPair, importX25519PrivateKey } from './x25519';
import { bytesEqual } from './helpers';

async function makeBobBundle(numOtpk: number) {
  const signing = await generateEd25519KeyPair();
  const dh = await generateX25519KeyPair();
  const { bundle, secrets } = await generatePrekeyBundle(signing.privateKey, dh, numOtpk);
  return { signing, dh, bundle, secrets };
}

describe('crypto/x3dh', () => {
  it('initiator and responder derive the same shared secret (with OTPK)', async () => {
    const alice = await generateX25519KeyPair();
    const bob = await makeBobBundle(1);

    const initResult = await x3dhInitiate(alice.privateKey, bob.bundle);
    const otpkPriv = await importX25519PrivateKey(bob.secrets.one_time_prekey_privates[0]);
    const spkPriv = await importX25519PrivateKey(bob.secrets.signed_prekey_private);
    const bobShared = await x3dhRespond(
      bob.dh.privateKey,
      spkPriv,
      alice.publicKeyBytes,
      initResult.ephemeralPublicKey,
      otpkPriv,
    );
    expect(bytesEqual(initResult.sharedSecret, bobShared)).toBe(true);
    expect(initResult.oneTimePreKeyIndex).toBe(0);
  });

  it('initiator and responder derive the same shared secret (no OTPK)', async () => {
    const alice = await generateX25519KeyPair();
    const bob = await makeBobBundle(0);

    const initResult = await x3dhInitiate(alice.privateKey, bob.bundle);
    const spkPriv = await importX25519PrivateKey(bob.secrets.signed_prekey_private);
    const bobShared = await x3dhRespond(
      bob.dh.privateKey,
      spkPriv,
      alice.publicKeyBytes,
      initResult.ephemeralPublicKey,
      null,
    );
    expect(bytesEqual(initResult.sharedSecret, bobShared)).toBe(true);
    expect(initResult.oneTimePreKeyIndex).toBeNull();
  });

  it('initiator throws if Bob\'s signed-prekey signature is wrong', async () => {
    const alice = await generateX25519KeyPair();
    const bob = await makeBobBundle(1);
    // Corrupt the signature (just flip the first byte).
    const tampered = {
      ...bob.bundle,
      signed_prekey_signature: bob.bundle.signed_prekey_signature.map((b, i) => (i === 0 ? b ^ 0xff : b)),
    };
    await expect(x3dhInitiate(alice.privateKey, tampered)).rejects.toThrow('Signed prekey signature');
  });

  it('shared secret is 32 bytes', async () => {
    const alice = await generateX25519KeyPair();
    const bob = await makeBobBundle(0);
    const { sharedSecret } = await x3dhInitiate(alice.privateKey, bob.bundle);
    expect(sharedSecret.length).toBe(32);
  });

  it('different initiators produce different secrets (ephemeral key prevents reuse)', async () => {
    const alice1 = await generateX25519KeyPair();
    const alice2 = await generateX25519KeyPair();
    const bob = await makeBobBundle(0);
    const r1 = await x3dhInitiate(alice1.privateKey, bob.bundle);
    const r2 = await x3dhInitiate(alice2.privateKey, bob.bundle);
    expect(bytesEqual(r1.sharedSecret, r2.sharedSecret)).toBe(false);
  });
});
