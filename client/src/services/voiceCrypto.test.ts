// Voice E2E AES-GCM-frame encryption + key manager.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  supportsE2EVoice,
  VoiceKeyManager,
  encryptFrame,
  decryptFrame,
} from './voiceCrypto';

// Stand-in for the RTCEncoded*Frame surface — only `.data` is read/written.
function makeFrame(bytes: Uint8Array): { data: ArrayBuffer } {
  return { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}

describe('supportsE2EVoice', () => {
  it('returns a boolean', () => {
    expect(typeof supportsE2EVoice()).toBe('boolean');
  });
});

describe('VoiceKeyManager', () => {
  let mgr: VoiceKeyManager;
  beforeEach(() => {
    mgr = new VoiceKeyManager();
  });

  it('starts with no local key', () => {
    expect(mgr.getLocalKey()).toBeNull();
    expect(mgr.getLocalRawKey()).toBeNull();
    expect(mgr.getLocalKeyId()).toBe(0);
  });

  it('generateLocalKey returns key + rawKey + keyId', async () => {
    const out = await mgr.generateLocalKey();
    expect(out.key).toBeDefined();
    expect(out.rawKey.byteLength).toBe(32); // AES-256
    expect(out.keyId).toBe(1); // (0 + 1) % 256
  });

  it('generateLocalKey rotates the keyId (mod 256)', async () => {
    for (let i = 0; i < 257; i++) await mgr.generateLocalKey();
    // 257 generations from initial 0: (0 + 257) % 256 = 1
    expect(mgr.getLocalKeyId()).toBe(1);
  });

  it('setRemoteKey + getRemoteKey roundtrip', async () => {
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    await mgr.setRemoteKey('peer-a', rawKey);
    expect(mgr.getRemoteKey('peer-a')).toBeDefined();
    expect(mgr.getRemoteKey('peer-b')).toBeUndefined();
  });

  it('removeUser drops the remote key', async () => {
    await mgr.setRemoteKey('peer-a', new Uint8Array(32));
    mgr.removeUser('peer-a');
    expect(mgr.getRemoteKey('peer-a')).toBeUndefined();
  });

  it('clear() wipes local + remote keys', async () => {
    await mgr.generateLocalKey();
    await mgr.setRemoteKey('peer-a', new Uint8Array(32));
    mgr.clear();
    expect(mgr.getLocalKey()).toBeNull();
    expect(mgr.getRemoteKey('peer-a')).toBeUndefined();
  });
});

describe('encryptFrame / decryptFrame', () => {
  it('round-trips an encrypted frame back to the original payload', async () => {
    const mgr = new VoiceKeyManager();
    const { key, rawKey, keyId } = await mgr.generateLocalKey();

    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const frame = makeFrame(payload);

    await encryptFrame(key, keyId, frame as never);
    // Encrypted frame is larger (ciphertext + IV + keyId + magic trailer).
    expect(frame.data.byteLength).toBeGreaterThan(payload.byteLength);

    // Import the same raw key as the "remote" identity that will decrypt.
    const importedKey = await crypto.subtle.importKey('raw', rawKey as BufferSource, 'AES-GCM', false, ['decrypt']);
    await decryptFrame(() => importedKey, frame as never);
    expect(Array.from(new Uint8Array(frame.data))).toEqual(Array.from(payload));
  });

  it('decryptFrame leaves frame untouched when no magic trailer is present', async () => {
    const payload = new Uint8Array([42, 42, 42]);
    const frame = makeFrame(payload);
    await decryptFrame(() => undefined, frame as never);
    expect(Array.from(new Uint8Array(frame.data))).toEqual([42, 42, 42]);
  });

  it('decryptFrame leaves frame untouched when no key is available for the keyId', async () => {
    const mgr = new VoiceKeyManager();
    const { key, keyId } = await mgr.generateLocalKey();
    const payload = new Uint8Array([1, 2, 3]);
    const frame = makeFrame(payload);
    await encryptFrame(key, keyId, frame as never);
    const beforeLen = frame.data.byteLength;
    // getKey returns undefined → frame is left alone (silent drop).
    await decryptFrame(() => undefined, frame as never);
    expect(frame.data.byteLength).toBe(beforeLen);
  });

  it('decryptFrame swallows AEAD failures (wrong key)', async () => {
    const mgr1 = new VoiceKeyManager();
    const out1 = await mgr1.generateLocalKey();
    const payload = new Uint8Array([1, 2, 3]);
    const frame = makeFrame(payload);
    await encryptFrame(out1.key, out1.keyId, frame as never);
    const beforeLen = frame.data.byteLength;
    // Decrypt with a DIFFERENT key — AES-GCM auth tag fails.
    const mgr2 = new VoiceKeyManager();
    const out2 = await mgr2.generateLocalKey();
    await decryptFrame(() => out2.key, frame as never);
    // Failed decrypt leaves frame.data unchanged (no throw, no rewrite).
    expect(frame.data.byteLength).toBe(beforeLen);
  });
});
