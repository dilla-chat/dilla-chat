// ─── Ed25519 ──────────────────────────────────────────────────────────────────

import { ed25519 } from '@noble/curves/ed25519.js';

export interface Ed25519KeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeyBytes: Uint8Array;
}

export async function generateEd25519KeyPair(): Promise<Ed25519KeyPair> {
  const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const pubRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  return {
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
    publicKeyBytes: new Uint8Array(pubRaw),
  };
}

export async function ed25519Sign(privateKey: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', privateKey);
  // PKCS8 for Ed25519: skip the 16-byte header to get the 32-byte seed
  const seed = new Uint8Array(pkcs8).slice(16);
  return ed25519.sign(data, seed);
}

export async function ed25519Verify(
  publicKey: CryptoKey,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', publicKey));
  return ed25519.verify(signature, data, raw);
}

export async function importEd25519PublicKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as unknown as BufferSource, 'Ed25519', true, ['verify']);
}

export async function exportEd25519PrivateKey(key: CryptoKey): Promise<Uint8Array> {
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', key);
  return new Uint8Array(pkcs8);
}

export async function importEd25519PrivateKey(pkcs8: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', pkcs8 as unknown as BufferSource, 'Ed25519', true, ['sign']);
}
