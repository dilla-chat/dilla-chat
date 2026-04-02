// ─── Safety Numbers ───────────────────────────────────────────────────────────

import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, encoder } from './helpers';

export async function generateSafetyNumber(
  ourIdentityKey: Uint8Array,
  ourId: string,
  theirIdentityKey: Uint8Array,
  theirId: string,
): Promise<string> {
  function fingerprint(identityKey: Uint8Array, stableId: string): Uint8Array {
    let data = concatBytes(
      encoder.encode('DillaFingerprint'),
      identityKey,
      encoder.encode(stableId),
    );
    // Iterate hash 5200 times as Signal does
    for (let i = 0; i < 5200; i++) {
      const input = concatBytes(data, identityKey);
      data = sha256(input);
    }
    return data;
  }

  const ourFp = fingerprint(ourIdentityKey, ourId);
  const theirFp = fingerprint(theirIdentityKey, theirId);

  // Combine in deterministic order
  const [first, second] = ourId < theirId ? [ourFp, theirFp] : [theirFp, ourFp];

  let digits = '';
  for (let chunkIdx = 0; chunkIdx < 12; chunkIdx++) {
    const fp = chunkIdx < 6 ? first : second;
    const offset = (chunkIdx % 6) * 5;
    if (offset + 5 <= fp.length) {
      const bytes = fp.slice(offset, offset + 5);
      const num = (
        (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]
      ) * 256 + bytes[4];
      // Same as Rust: u64::from_be_bytes % 100000
      digits += String(((num % 100000) + 100000) % 100000).padStart(5, '0');
    }
  }
  return digits;
}
