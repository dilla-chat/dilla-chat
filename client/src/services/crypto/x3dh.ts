// ─── X3DH ─────────────────────────────────────────────────────────────────────

import { concatBytes, encoder } from './helpers';
import { importEd25519PublicKey, ed25519Verify } from './ed25519';
import { generateX25519KeyPair, x25519DH } from './x25519';
import { hkdfDerive } from './hkdf';
import type { PrekeyBundle } from './prekeys';

export interface X3DHResult {
  sharedSecret: Uint8Array;
  ephemeralPublicKey: Uint8Array;
  oneTimePreKeyIndex: number | null;
}

/**
 * X3DH initiator: Alice starts a session with Bob.
 */
export async function x3dhInitiate(
  aliceIdentityDhPrivate: CryptoKey,
  bobBundle: PrekeyBundle,
): Promise<X3DHResult> {
  // Verify Bob's signed prekey signature
  const bobVerifyKey = await importEd25519PublicKey(new Uint8Array(bobBundle.identity_key));
  const valid = await ed25519Verify(
    bobVerifyKey,
    new Uint8Array(bobBundle.signed_prekey_signature),
    new Uint8Array(bobBundle.signed_prekey),
  );
  if (!valid) throw new Error('Signed prekey signature verification failed');

  const ephemeral = await generateX25519KeyPair();
  const bobSignedPrekey = new Uint8Array(bobBundle.signed_prekey);
  const bobIdentityDh = new Uint8Array(bobBundle.identity_dh_key);

  // DH1: alice_identity × bob_signed_prekey
  const dh1 = await x25519DH(aliceIdentityDhPrivate, bobSignedPrekey);
  // DH2: alice_ephemeral × bob_identity_dh
  const dh2 = await x25519DH(ephemeral.privateKey, bobIdentityDh);
  // DH3: alice_ephemeral × bob_signed_prekey
  const dh3 = await x25519DH(ephemeral.privateKey, bobSignedPrekey);

  let ikm = concatBytes(dh1, dh2, dh3);
  let otpkIndex: number | null = null;

  if (bobBundle.one_time_prekeys.length > 0) {
    const bobOtpk = new Uint8Array(bobBundle.one_time_prekeys[0]);
    const dh4 = await x25519DH(ephemeral.privateKey, bobOtpk);
    ikm = concatBytes(ikm, dh4);
    otpkIndex = 0;
  }

  const sharedSecret = await hkdfDerive(ikm, encoder.encode('DillaX3DH'), 32);
  return { sharedSecret, ephemeralPublicKey: ephemeral.publicKeyBytes, oneTimePreKeyIndex: otpkIndex };
}

/**
 * X3DH responder: Bob completes the handshake.
 */
export async function x3dhRespond(
  bobIdentityDhPrivate: CryptoKey,
  bobSignedPrekeyPrivate: CryptoKey,
  aliceIdentityDhKey: Uint8Array,
  aliceEphemeralKey: Uint8Array,
  oneTimePrekeyPrivate: CryptoKey | null,
): Promise<Uint8Array> {
  // DH1: bob_signed_prekey × alice_identity_dh
  const dh1 = await x25519DH(bobSignedPrekeyPrivate, aliceIdentityDhKey);
  // DH2: bob_identity × alice_ephemeral
  const dh2 = await x25519DH(bobIdentityDhPrivate, aliceEphemeralKey);
  // DH3: bob_signed_prekey × alice_ephemeral
  const dh3 = await x25519DH(bobSignedPrekeyPrivate, aliceEphemeralKey);

  let ikm = concatBytes(dh1, dh2, dh3);

  if (oneTimePrekeyPrivate) {
    const dh4 = await x25519DH(oneTimePrekeyPrivate, aliceEphemeralKey);
    ikm = concatBytes(ikm, dh4);
  }

  return hkdfDerive(ikm, encoder.encode('DillaX3DH'), 32);
}
