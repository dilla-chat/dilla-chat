// ─── HKDF-SHA256 ─────────────────────────────────────────────────────────────

import { encoder } from './helpers';

export async function hkdfDerive(
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
  salt?: Uint8Array,
): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey(
    'raw', ikm as unknown as BufferSource, 'HKDF', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: (salt || new Uint8Array(0)) as unknown as BufferSource,
      info: info as unknown as BufferSource,
    },
    baseKey,
    length * 8,
  );
  return new Uint8Array(bits);
}

// KDF for root chain: DH output + old root key → new root key + chain key
export async function kdfRoot(rootKey: Uint8Array, dhOutput: Uint8Array): Promise<[Uint8Array, Uint8Array]> {
  const baseKey = await crypto.subtle.importKey('raw', dhOutput as unknown as BufferSource, 'HKDF', false, ['deriveBits']);
  const newRoot = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: rootKey as unknown as BufferSource, info: encoder.encode('DillaRootKey') as unknown as BufferSource },
    baseKey, 256,
  ));
  const chainKey = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: rootKey as unknown as BufferSource, info: encoder.encode('DillaChainKey') as unknown as BufferSource },
    baseKey, 256,
  ));
  return [newRoot, chainKey];
}

// KDF for sending/receiving chain: chain key → next chain key + message key
export async function kdfChain(chainKey: Uint8Array): Promise<[Uint8Array, Uint8Array]> {
  const key = await crypto.subtle.importKey(
    'raw', chainKey as unknown as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const messageKey = new Uint8Array(await crypto.subtle.sign('HMAC', key, new Uint8Array([0x01])));
  const nextChainKey = new Uint8Array(await crypto.subtle.sign('HMAC', key, new Uint8Array([0x02])));
  return [nextChainKey, messageKey];
}
