// H-12d.1: worker-scope cache for the user's identity DH private key
// + the wrap/unwrap ops that consume it.
//
// The identity DH key is a non-extractable WebCrypto CryptoKey, so
// even when both threads hold a reference the raw bytes never enter
// JS. What the worker buys you here is:
//   - Once the main thread discards its reference (planned H-12d.2),
//     an XSS post-init has no way to invoke crypto.subtle ops with
//     the key.
//   - The X25519 DH + HKDF + AES-GCM derivations run off the main
//     thread; an XSS can't observe the intermediate shared-secret
//     bytes by reading variables in the surrounding code.
//
// Today the main thread still holds its reference for the
// backend='main' fallback and for X3DH (also still main-thread,
// moves in H-12d.2). The migration is incremental.

import { x25519DH } from './x25519';
import { hkdfDerive } from './hkdf';
import { aesGcmEncrypt, aesGcmDecrypt } from './aesGcm';
import { encoder, toBase64, fromBase64 } from './helpers';

let identityDhPrivateKey: CryptoKey | null = null;
let identityDhPublicKeyBytes: Uint8Array | null = null;

/** Called once at worker init from the main thread. Subsequent
 *  init calls replace the cached key (account switch).
 *
 *  H-12d.2 added `publicKeyBytes` so the X3DH-initiate path inside
 *  the worker can include them in the bootstrap header without
 *  re-deriving from the private key. */
export function setIdentityDhPrivateKey(key: CryptoKey | null): void {
  identityDhPrivateKey = key;
}

export function setIdentityDhPublicKeyBytes(bytes: Uint8Array | null): void {
  identityDhPublicKeyBytes = bytes ? new Uint8Array(bytes) : null;
}

export function hasIdentityDhPrivateKey(): boolean {
  return identityDhPrivateKey !== null;
}

export function getIdentityDhPrivateKey(): CryptoKey | null {
  return identityDhPrivateKey;
}

export function getIdentityDhPublicKeyBytes(): Uint8Array | null {
  return identityDhPublicKeyBytes;
}

/** H-12d.1: derive a shared secret with the peer's identity DH public
 *  key, HKDF into a 32-byte wrap key, AES-GCM encrypt the plaintext.
 *  Matches cryptoManager.wrapForPeer's wire shape so the call sites
 *  switch backends cleanly. */
export async function opWrapForPeer(
  peerIdentityDhPubB64: string,
  plaintextB64: string,
): Promise<string> {
  if (!identityDhPrivateKey) {
    throw new Error('worker identity DH key not initialised');
  }
  const peerPub = fromBase64(peerIdentityDhPubB64);
  const plaintext = fromBase64(plaintextB64);
  const shared = await x25519DH(identityDhPrivateKey, peerPub);
  const wrapKey = await hkdfDerive(
    shared,
    encoder.encode('DillaPeerWrap'),
    32,
    new Uint8Array(32),
  );
  const ct = await aesGcmEncrypt(wrapKey, plaintext);
  return toBase64(ct);
}

export async function opUnwrapFromPeer(
  peerIdentityDhPubB64: string,
  ciphertextB64: string,
): Promise<string> {
  if (!identityDhPrivateKey) {
    throw new Error('worker identity DH key not initialised');
  }
  const peerPub = fromBase64(peerIdentityDhPubB64);
  const ciphertext = fromBase64(ciphertextB64);
  const shared = await x25519DH(identityDhPrivateKey, peerPub);
  const wrapKey = await hkdfDerive(
    shared,
    encoder.encode('DillaPeerWrap'),
    32,
    new Uint8Array(32),
  );
  const plaintext = await aesGcmDecrypt(wrapKey, ciphertext);
  return toBase64(plaintext);
}
