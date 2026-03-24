// ─── Session Encryption (for persisting CryptoManager) ────────────────────────

import { encoder, decoder } from './helpers';
import { hkdfDerive } from './hkdf';
import { aesGcmEncrypt, aesGcmDecrypt } from './aesGcm';

export async function passphraseToKey(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
  return hkdfDerive(
    encoder.encode(passphrase),
    salt,
    32,
    encoder.encode('DillaSessions'),
  );
}

/** Encrypt session data. Format: [16-byte salt][encrypted data] */
export async function encryptSessionData(data: object, passphrase: string): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await passphraseToKey(passphrase, salt);
  const json = encoder.encode(JSON.stringify(data));
  const encrypted = await aesGcmEncrypt(key, json);
  // Prepend salt to encrypted data
  const result = new Uint8Array(16 + encrypted.length);
  result.set(salt, 0);
  result.set(encrypted, 16);
  return result;
}

/** Decrypt session data. Format: [16-byte salt][encrypted data] */
export async function decryptSessionData(encrypted: Uint8Array, passphrase: string): Promise<object> {
  if (encrypted.length < 16) throw new Error('Session data too short');
  const salt = encrypted.slice(0, 16);
  const ciphertext = encrypted.slice(16);
  const key = await passphraseToKey(passphrase, salt);
  const json = await aesGcmDecrypt(key, ciphertext);
  return JSON.parse(decoder.decode(json));
}
