/**
 * Voice E2E encryption using WebRTC Encoded Transforms + AES-256-GCM.
 *
 * Frame format (appended trailer):
 *   [encrypted payload] [12-byte IV] [1-byte keyId] [4-byte magic 0xDE 0xAD 0xBE 0xEF]
 *
 * The SFU forwards RTP payloads blindly — it never decrypts.
 */

const E2E_MAGIC = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
const IV_LENGTH = 12;
const TRAILER_LENGTH = IV_LENGTH + 1 + E2E_MAGIC.length; // 17 bytes

/** Check if the browser supports WebRTC Encoded Transforms. */
export function supportsE2EVoice(): boolean {
  return typeof RTCRtpScriptTransform !== 'undefined';
}

/**
 * VoiceKeyManager manages per-user encryption keys for a voice session.
 */
export class VoiceKeyManager {
  private keys: Map<string, CryptoKey> = new Map();
  private rawKeys: Map<string, Uint8Array> = new Map();
  private localKey: CryptoKey | null = null;
  private localRawKey: Uint8Array | null = null;
  private localKeyId = 0;

  /** Generate a new AES-256-GCM key for the local user. */
  async generateLocalKey(): Promise<{ key: CryptoKey; rawKey: Uint8Array; keyId: number }> {
    this.localKeyId = (this.localKeyId + 1) % 256;
    this.localKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
    this.localRawKey = new Uint8Array(await crypto.subtle.exportKey('raw', this.localKey));
    return { key: this.localKey, rawKey: this.localRawKey, keyId: this.localKeyId };
  }

  /** Import a received key for a remote user. */
  async setRemoteKey(userId: string, rawKey: Uint8Array): Promise<void> {
    const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM', length: 256 }, false, [
      'decrypt',
    ]);
    this.keys.set(userId, key);
    this.rawKeys.set(userId, rawKey);
  }

  getLocalKey(): CryptoKey | null {
    return this.localKey;
  }

  getLocalRawKey(): Uint8Array | null {
    return this.localRawKey;
  }

  getLocalKeyId(): number {
    return this.localKeyId;
  }

  getRemoteKey(userId: string): CryptoKey | undefined {
    return this.keys.get(userId);
  }

  removeUser(userId: string): void {
    this.keys.delete(userId);
    this.rawKeys.delete(userId);
  }

  clear(): void {
    this.keys.clear();
    this.rawKeys.clear();
    this.localKey = null;
    this.localRawKey = null;
  }
}

/**
 * Encrypt an encoded audio/video frame in-place using AES-256-GCM.
 * Appends [IV | keyId | magic] trailer to the frame data.
 */
export async function encryptFrame(
  key: CryptoKey,
  keyId: number,
  frame: RTCEncodedAudioFrame | RTCEncodedVideoFrame,
): Promise<void> {
  const data = new Uint8Array(frame.data);

  // Generate random IV
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  // Encrypt the frame payload
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);

  // Build output: encrypted + IV + keyId + magic
  const encryptedBytes = new Uint8Array(encrypted);
  const output = new Uint8Array(encryptedBytes.length + TRAILER_LENGTH);
  output.set(encryptedBytes, 0);
  output.set(iv, encryptedBytes.length);
  output[encryptedBytes.length + IV_LENGTH] = keyId;
  output.set(E2E_MAGIC, encryptedBytes.length + IV_LENGTH + 1);

  frame.data = output.buffer;
}

/**
 * Decrypt an encoded audio/video frame in-place using AES-256-GCM.
 * Reads the trailer to find IV and keyId.
 */
export async function decryptFrame(
  getKey: (keyId: number) => CryptoKey | undefined,
  frame: RTCEncodedAudioFrame | RTCEncodedVideoFrame,
): Promise<void> {
  const data = new Uint8Array(frame.data);

  // Check for magic trailer
  if (data.length < TRAILER_LENGTH) return; // not encrypted
  const magicStart = data.length - E2E_MAGIC.length;
  for (let i = 0; i < E2E_MAGIC.length; i++) {
    if (data[magicStart + i] !== E2E_MAGIC[i]) return; // not encrypted
  }

  // Extract trailer
  const keyId = data[magicStart - 1];
  const ivStart = magicStart - 1 - IV_LENGTH;
  const iv = data.slice(ivStart, ivStart + IV_LENGTH);
  const encrypted = data.slice(0, ivStart);

  const key = getKey(keyId);
  if (!key) {
    // No key available — drop frame silently (key may not have arrived yet)
    return;
  }

  try {
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
    frame.data = decrypted;
  } catch {
    // Decryption failed — likely key mismatch during rotation, drop frame
  }
}
