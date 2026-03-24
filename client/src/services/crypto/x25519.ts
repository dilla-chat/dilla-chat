// ─── X25519 (ECDH) ───────────────────────────────────────────────────────────

export interface X25519KeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeyBytes: Uint8Array;
}

export async function generateX25519KeyPair(): Promise<X25519KeyPair> {
  const keyPair = await crypto.subtle.generateKey('X25519', true, ['deriveBits']) as CryptoKeyPair;
  const pubRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  return {
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
    publicKeyBytes: new Uint8Array(pubRaw),
  };
}

export async function x25519DH(
  privateKey: CryptoKey,
  publicKeyBytes: Uint8Array,
): Promise<Uint8Array> {
  const pubKey = await crypto.subtle.importKey('raw', publicKeyBytes as unknown as BufferSource, 'X25519', false, []);
  const bits = await crypto.subtle.deriveBits(
    { name: 'X25519', public: pubKey },
    privateKey,
    256,
  );
  return new Uint8Array(bits);
}

export async function importX25519PublicKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as unknown as BufferSource, 'X25519', true, []);
}

export async function exportX25519PrivateKey(key: CryptoKey): Promise<Uint8Array> {
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', key);
  return new Uint8Array(pkcs8);
}

export async function importX25519PrivateKey(pkcs8: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', pkcs8 as unknown as BufferSource, 'X25519', true, ['deriveBits']);
}
