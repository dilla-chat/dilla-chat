// ─── Prekey Bundle ────────────────────────────────────────────────────────────

import { fromBase64url } from './helpers';
import { ed25519Sign } from './ed25519';
import { generateX25519KeyPair, exportX25519PrivateKey } from './x25519';
import type { X25519KeyPair } from './x25519';

export interface PrekeyBundle {
  identity_key: number[];        // Ed25519 public key
  identity_dh_key: number[];     // X25519 public key for DH
  signed_prekey: number[];       // X25519 public key, signed
  signed_prekey_signature: number[];
  one_time_prekeys: number[][];  // X25519 public keys
}

export interface PrekeySecrets {
  signed_prekey_private: Uint8Array;  // PKCS8 of X25519 private
  one_time_prekey_privates: Uint8Array[];
  identity_dh_private: Uint8Array;    // PKCS8 of identity X25519 DH key
}

export async function generatePrekeyBundle(
  identitySigningKey: CryptoKey,
  identityDhKeyPair: X25519KeyPair,
  numOneTimePrekeys: number,
): Promise<{ bundle: PrekeyBundle; secrets: PrekeySecrets }> {
  // Signed prekey
  const signedPrekey = await generateX25519KeyPair();
  const signature = await ed25519Sign(identitySigningKey, signedPrekey.publicKeyBytes);

  // One-time prekeys
  const otpkPairs: X25519KeyPair[] = [];
  for (let i = 0; i < numOneTimePrekeys; i++) {
    otpkPairs.push(await generateX25519KeyPair());
  }

  // Get identity public key from the signing key's JWK
  const jwk = await crypto.subtle.exportKey('jwk', identitySigningKey);
  const identityPubBytes = fromBase64url(jwk.x!);

  const bundle: PrekeyBundle = {
    identity_key: Array.from(identityPubBytes),
    identity_dh_key: Array.from(identityDhKeyPair.publicKeyBytes),
    signed_prekey: Array.from(signedPrekey.publicKeyBytes),
    signed_prekey_signature: Array.from(signature),
    one_time_prekeys: otpkPairs.map(kp => Array.from(kp.publicKeyBytes)),
  };

  const secrets: PrekeySecrets = {
    signed_prekey_private: await exportX25519PrivateKey(signedPrekey.privateKey),
    one_time_prekey_privates: await Promise.all(
      otpkPairs.map(kp => exportX25519PrivateKey(kp.privateKey)),
    ),
    identity_dh_private: await exportX25519PrivateKey(identityDhKeyPair.privateKey),
  };

  return { bundle, secrets };
}
