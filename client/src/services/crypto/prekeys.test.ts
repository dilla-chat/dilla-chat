import { describe, it, expect } from 'vitest';
import { generatePrekeyBundle } from './prekeys';
import { generateEd25519KeyPair, ed25519Verify, importEd25519PublicKey } from './ed25519';
import { generateX25519KeyPair, importX25519PrivateKey, x25519DH } from './x25519';
import { bytesEqual } from './helpers';

describe('crypto/prekeys', () => {
  it('produces a bundle with the requested number of one-time prekeys', async () => {
    const signing = await generateEd25519KeyPair();
    const dh = await generateX25519KeyPair();
    const { bundle } = await generatePrekeyBundle(signing.privateKey, dh, 5);
    expect(bundle.one_time_prekeys.length).toBe(5);
  });

  it('signed_prekey signature verifies against the identity Ed25519 key', async () => {
    const signing = await generateEd25519KeyPair();
    const dh = await generateX25519KeyPair();
    const { bundle } = await generatePrekeyBundle(signing.privateKey, dh, 0);
    const identityPub = await importEd25519PublicKey(new Uint8Array(bundle.identity_key));
    const ok = await ed25519Verify(
      identityPub,
      new Uint8Array(bundle.signed_prekey_signature),
      new Uint8Array(bundle.signed_prekey),
    );
    expect(ok).toBe(true);
  });

  it('bundle.identity_dh_key matches the supplied X25519 pair', async () => {
    const signing = await generateEd25519KeyPair();
    const dh = await generateX25519KeyPair();
    const { bundle } = await generatePrekeyBundle(signing.privateKey, dh, 0);
    expect(bytesEqual(new Uint8Array(bundle.identity_dh_key), dh.publicKeyBytes)).toBe(true);
  });

  it('one-time prekey privates roundtrip to a valid X25519 DH', async () => {
    const signing = await generateEd25519KeyPair();
    const dh = await generateX25519KeyPair();
    const { bundle, secrets } = await generatePrekeyBundle(signing.privateKey, dh, 1);
    const otpkPriv = await importX25519PrivateKey(secrets.one_time_prekey_privates[0]);
    const peer = await generateX25519KeyPair();
    // Local DH(otpk_priv, peer_pub) should match remote DH(peer_priv, otpk_pub_from_bundle).
    const local = await x25519DH(otpkPriv, peer.publicKeyBytes);
    const remote = await x25519DH(peer.privateKey, new Uint8Array(bundle.one_time_prekeys[0]));
    expect(bytesEqual(local, remote)).toBe(true);
  });

  it('signed prekey private roundtrips and produces matching DH with the published public', async () => {
    const signing = await generateEd25519KeyPair();
    const dh = await generateX25519KeyPair();
    const { bundle, secrets } = await generatePrekeyBundle(signing.privateKey, dh, 0);
    const spkPriv = await importX25519PrivateKey(secrets.signed_prekey_private);
    const peer = await generateX25519KeyPair();
    const local = await x25519DH(spkPriv, peer.publicKeyBytes);
    const remote = await x25519DH(peer.privateKey, new Uint8Array(bundle.signed_prekey));
    expect(bytesEqual(local, remote)).toBe(true);
  });

  it('numOneTimePrekeys=0 yields an empty one_time_prekeys array', async () => {
    const signing = await generateEd25519KeyPair();
    const dh = await generateX25519KeyPair();
    const { bundle, secrets } = await generatePrekeyBundle(signing.privateKey, dh, 0);
    expect(bundle.one_time_prekeys).toEqual([]);
    expect(secrets.one_time_prekey_privates).toEqual([]);
  });
});
