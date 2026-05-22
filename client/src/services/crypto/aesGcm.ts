// ─── AES-256-GCM ─────────────────────────────────────────────────────────────
//
// INVARIANT: every call to aesGcmEncrypt must use a key that will be used
// for AT MOST ONE message. Nonces here are 12 random bytes — by NIST
// SP 800-38D the random-IV collision probability climbs past 2^-32 after
// ~2^32 messages under the same key. The Double Ratchet and group
// SenderKey chains both derive a fresh message key per message, so this
// invariant holds by construction. If you ever introduce a code path
// that calls aesGcmEncrypt with a long-lived or reused key, switch to a
// counter-based nonce or rotate keys before the cap.

import { concatBytes, randomBytes } from './helpers';

export async function aesGcmEncrypt(key: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const nonce = randomBytes(12);
  const cryptoKey = await crypto.subtle.importKey(
    'raw', key as unknown as BufferSource, { name: 'AES-GCM' }, false, ['encrypt'],
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce as unknown as BufferSource },
    cryptoKey,
    plaintext as unknown as BufferSource,
  );
  return concatBytes(nonce, new Uint8Array(ciphertext));
}

export async function aesGcmDecrypt(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  if (data.length < 12) throw new Error('Ciphertext too short');
  const nonce = data.slice(0, 12);
  const ciphertext = data.slice(12);
  const cryptoKey = await crypto.subtle.importKey(
    'raw', key as unknown as BufferSource, { name: 'AES-GCM' }, false, ['decrypt'],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce as unknown as BufferSource },
    cryptoKey,
    ciphertext as unknown as BufferSource,
  );
  return new Uint8Array(plaintext);
}
