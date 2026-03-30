import { ws } from '../websocket';
import { useVoiceStore } from '../../stores/voiceStore';
import { useAuthStore } from '../../stores/authStore';
import { VoiceKeyManager } from '../voiceCrypto';
import { cryptoService } from '../crypto';

export class VoiceEncryptionManager {
  e2eEnabled = false;
  readonly voiceKeyManager = new VoiceKeyManager();
  encryptWorker: Worker | null = null;
  readonly decryptWorkers: Map<string, Worker> = new Map();

  /** Set up E2E voice encryption transforms on all senders. */
  async setupE2EEncryption(
    pc: RTCPeerConnection,
    localUserId: string | null,
  ): Promise<void> {
    // Generate local voice key
    const { rawKey, keyId } = await this.voiceKeyManager.generateLocalKey();

    // Create encrypt worker and apply to all senders
    this.encryptWorker = new Worker(
      new URL('../../workers/voiceEncryptWorker.ts', import.meta.url),
      { type: 'module' },
    );
    this.encryptWorker.postMessage({
      type: 'setKey',
      key: rawKey.buffer,
      keyId,
    });

    // Apply encrypt transform to all outgoing tracks
    for (const sender of pc.getSenders()) {
      if (sender.track) {
        const transform = new RTCRtpScriptTransform(this.encryptWorker, { operation: 'encrypt' });
        sender.transform = transform;
      }
    }

    // Also set up our own key in the decrypt map (for self-hearing in some SFU configs)
    await this.voiceKeyManager.setRemoteKey(localUserId ?? '', rawKey);

    console.log('[Voice] E2E encryption enabled');
  }

  /** Distribute voice key to all participants, encrypted per-recipient via Signal Protocol. */
  async distributeVoiceKey(
    teamId: string | null,
    channelId: string | null,
    localUserId: string | null,
  ): Promise<void> {
    if (!this.e2eEnabled || !teamId || !channelId) return;

    const rawKey = this.voiceKeyManager.getLocalRawKey();
    const keyId = this.voiceKeyManager.getLocalKeyId();
    if (!rawKey) return;

    const keyBase64 = btoa(String.fromCodePoint(...rawKey));
    const derivedKey = useAuthStore.getState().derivedKey;

    // Get all peers in the channel
    const peers = useVoiceStore.getState().peers;
    const encryptedKeys: Record<string, string> = {};
    for (const userId of Object.keys(peers)) {
      if (userId === localUserId) continue;
      try {
        if (derivedKey) {
          // Encrypt the voice key for this specific peer using their Signal Protocol session
          encryptedKeys[userId] = await cryptoService.encryptDM(teamId, userId, keyBase64, channelId, derivedKey);
        } else {
          console.warn('[Voice] No derived key — cannot encrypt voice key for', userId);
        }
      } catch (err) {
        console.warn('[Voice] Failed to encrypt voice key for', userId, err);
      }
    }

    if (Object.keys(encryptedKeys).length > 0) {
      ws.voiceKeyDistribute(teamId, channelId, keyId, encryptedKeys);
    }
  }

  /** Handle received voice key from another participant (decrypts via Signal Protocol). */
  async handleReceivedVoiceKey(
    senderId: string,
    keyId: number,
    encryptedKey: string,
    teamId: string | null,
    channelId: string | null,
  ): Promise<void> {
    const derivedKey = useAuthStore.getState().derivedKey;

    if (!derivedKey || !teamId || !channelId) {
      console.warn('[Voice] Missing derivedKey/teamId/channelId — rejecting voice key from', senderId);
      return;
    }

    let keyBase64: string;
    try {
      // Decrypt the voice key using the sender's Signal Protocol session
      keyBase64 = await cryptoService.decryptDM(teamId, senderId, encryptedKey, channelId, derivedKey);
    } catch (err) {
      console.error('[Voice] Failed to decrypt voice key from', senderId, err);
      return;
    }

    const rawKey = new Uint8Array(
      atob(keyBase64)
        .split('')
        .map((c) => c.codePointAt(0)!),
    );

    await this.voiceKeyManager.setRemoteKey(senderId, rawKey);

    // Update all decrypt workers with the new key
    for (const worker of this.decryptWorkers.values()) {
      worker.postMessage({
        type: 'addDecryptKey',
        key: rawKey.buffer,
        keyId,
      });
    }

    console.log('[Voice] Received E2E key from', senderId);
  }

  /** Apply decrypt transform to an incoming track's receiver. */
  applyDecryptTransform(
    receiver: RTCRtpReceiver,
    streamId: string,
    localUserId: string | null,
  ): void {
    if (!this.e2eEnabled) return;

    const worker = new Worker(
      new URL('../../workers/voiceEncryptWorker.ts', import.meta.url),
      { type: 'module' },
    );
    this.decryptWorkers.set(streamId, worker);

    const transform = new RTCRtpScriptTransform(worker, { operation: 'decrypt' });
    receiver.transform = transform;

    // Send all known keys to the new decrypt worker
    const peers = useVoiceStore.getState().peers;
    for (const userId of Object.keys(peers)) {
      const rawKey = this.voiceKeyManager.getLocalRawKey();
      if (userId === localUserId && rawKey) {
        worker.postMessage({
          type: 'addDecryptKey',
          key: rawKey.buffer,
          keyId: this.voiceKeyManager.getLocalKeyId(),
        });
      }
    }
  }

  /** Clean up all encryption resources. Call on disconnect. */
  cleanup(): void {
    this.e2eEnabled = false;
    this.voiceKeyManager.clear();
    if (this.encryptWorker) {
      this.encryptWorker.terminate();
      this.encryptWorker = null;
    }
    for (const worker of this.decryptWorkers.values()) {
      worker.terminate();
    }
    this.decryptWorkers.clear();
  }
}
