// ─── HKDF-SHA256 ─────────────────────────────────────────────────────────────

import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';

export async function hkdfDerive(
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
  salt?: Uint8Array,
): Promise<Uint8Array> {
  return hkdf(sha256, ikm, salt ?? new Uint8Array(0), info, length);
}

// KDF for root chain: DH output + old root key → new root key + chain key
export async function kdfRoot(
  rootKey: Uint8Array,
  dhOutput: Uint8Array,
): Promise<[Uint8Array, Uint8Array]> {
  const derived = hkdf(sha256, dhOutput, rootKey, new TextEncoder().encode('DillaRootKey'), 64);
  return [derived.slice(0, 32), derived.slice(32, 64)];
}

// KDF for sending/receiving chain: chain key → next chain key + message key
export async function kdfChain(chainKey: Uint8Array): Promise<[Uint8Array, Uint8Array]> {
  const messageKey = hmac(sha256, chainKey, new Uint8Array([0x01]));
  const nextChainKey = hmac(sha256, chainKey, new Uint8Array([0x02]));
  return [nextChainKey, messageKey];
}
