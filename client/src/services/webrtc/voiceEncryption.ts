import { ws } from '../websocket';
import { useVoiceStore } from '../../stores/voiceStore';
import { VoiceKeyManager } from '../voiceCrypto';

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

  /** Distribute voice key to all participants in the channel. */
  distributeVoiceKey(
    teamId: string | null,
    channelId: string | null,
    localUserId: string | null,
  ): void {
    if (!this.e2eEnabled || !teamId || !channelId) return;

    const rawKey = this.voiceKeyManager.getLocalRawKey();
    const keyId = this.voiceKeyManager.getLocalKeyId();
    if (!rawKey) return;

    // For now, distribute the raw key base64-encoded.
    // In a full implementation, this would be encrypted per-recipient via Signal Protocol.
    const keyBase64 = btoa(String.fromCodePoint(...rawKey));

    // Get all peers in the channel
    const peers = useVoiceStore.getState().peers;
    const encryptedKeys: Record<string, string> = {};
    for (const userId of Object.keys(peers)) {
      if (userId !== localUserId) {
        encryptedKeys[userId] = keyBase64;
      }
    }

    if (Object.keys(encryptedKeys).length > 0) {
      ws.voiceKeyDistribute(teamId, channelId, keyId, encryptedKeys);
    }
  }

  /** Handle received voice key from another participant. */
  async handleReceivedVoiceKey(
    senderId: string,
    keyId: number,
    encryptedKey: string,
  ): Promise<void> {
    // Decode the key (in full implementation, decrypt via Signal Protocol first)
    const rawKey = new Uint8Array(
      atob(encryptedKey)
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
