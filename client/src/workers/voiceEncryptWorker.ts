/**
 * WebRTC Encoded Transform worker for E2E voice encryption.
 *
 * This worker runs inside an RTCRtpScriptTransform context.
 * It receives encoded frames, encrypts (sender) or decrypts (receiver),
 * and passes them along the pipeline.
 *
 * Communication with the main thread:
 *   postMessage({ type: 'setKey', key: ArrayBuffer, keyId: number })
 *   postMessage({ type: 'setDecryptKeys', keys: { [keyId: string]: ArrayBuffer } })
 */

const E2E_MAGIC = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
const IV_LENGTH = 12;

let encryptKey: CryptoKey | null = null;
let encryptKeyId = 0;
const decryptKeys = new Map<number, CryptoKey>();

async function importKey(raw: ArrayBuffer, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, usages);
}

// Handle messages from the main thread
self.onmessage = async (event: MessageEvent) => {
  const { type, key, keyId, keys } = event.data;

  if (type === 'setKey' && key) {
    encryptKey = await importKey(key, ['encrypt']);
    encryptKeyId = keyId ?? 0;
  } else if (type === 'setDecryptKeys' && keys) {
    for (const [id, rawKey] of Object.entries(keys)) {
      decryptKeys.set(Number(id), await importKey(rawKey as ArrayBuffer, ['decrypt']));
    }
  } else if (type === 'addDecryptKey' && key) {
    decryptKeys.set(keyId ?? 0, await importKey(key, ['decrypt']));
  } else if (type === 'removeDecryptKey') {
    decryptKeys.delete(keyId ?? 0);
  }
};

async function encryptFrame(
  frame: RTCEncodedAudioFrame | RTCEncodedVideoFrame,
  controller: TransformStreamDefaultController,
): Promise<void> {
  if (!encryptKey) {
    controller.enqueue(frame);
    return;
  }

  try {
    const data = new Uint8Array(frame.data);
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, encryptKey, data),
    );

    // Build: encrypted + IV + keyId + magic
    const output = new Uint8Array(encrypted.length + IV_LENGTH + 1 + E2E_MAGIC.length);
    output.set(encrypted, 0);
    output.set(iv, encrypted.length);
    output[encrypted.length + IV_LENGTH] = encryptKeyId;
    output.set(E2E_MAGIC, encrypted.length + IV_LENGTH + 1);

    frame.data = output.buffer;
  } catch {
    // Encryption failed — pass through unencrypted
  }
  controller.enqueue(frame);
}

async function decryptFrame(
  frame: RTCEncodedAudioFrame | RTCEncodedVideoFrame,
  controller: TransformStreamDefaultController,
): Promise<void> {
  const data = new Uint8Array(frame.data);

  // Check for E2E magic trailer
  if (data.length >= IV_LENGTH + 1 + E2E_MAGIC.length) {
    const magicStart = data.length - E2E_MAGIC.length;
    let hasMagic = true;
    for (let i = 0; i < E2E_MAGIC.length; i++) {
      if (data[magicStart + i] !== E2E_MAGIC[i]) {
        hasMagic = false;
        break;
      }
    }

    if (hasMagic) {
      const keyId = data[magicStart - 1];
      const ivStart = magicStart - 1 - IV_LENGTH;
      const iv = data.slice(ivStart, ivStart + IV_LENGTH);
      const encrypted = data.slice(0, ivStart);

      const key = decryptKeys.get(keyId);
      if (key) {
        try {
          const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
          frame.data = decrypted;
        } catch {
          // Decryption failed — drop frame (key mismatch during rotation)
          return;
        }
      } else {
        // No key for this keyId — drop frame
        return;
      }
    }
  }

  controller.enqueue(frame);
}

// Handle RTCRtpScriptTransform events
self.addEventListener('rtctransform', (event: Event) => {
  const transformEvent = event as RTCTransformEvent;
  const { readable, writable } = transformEvent.transformer;
  const operation = transformEvent.transformer.options?.operation ?? 'encrypt';

  const transform = new TransformStream({
    transform: operation === 'encrypt' ? encryptFrame : decryptFrame,
  });

  readable.pipeThrough(transform).pipeTo(writable);
});
