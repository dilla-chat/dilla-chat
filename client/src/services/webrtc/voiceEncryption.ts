import { ws } from '../websocket';
import { useVoiceStore } from '../../stores/voiceStore';
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

    // Static-static ECDH wrap (wrapForPeer) so we don't depend on a
    // Double Ratchet session — voice keys are one-shot exchanges and
    // both sides already publish their identity DH key in the prekey
    // bundle, which is all wrapForPeer needs.
    const peers = useVoiceStore.getState().peers;
    const encryptedKeys: Record<string, string> = {};
    for (const userId of Object.keys(peers)) {
      if (userId === localUserId) continue;
      try {
        encryptedKeys[userId] = await cryptoService.wrapForPeer(teamId, userId, rawKey);
      } catch (err) {
        console.warn('[Voice] Failed to wrap voice key for', userId, err);
      }
    }

    if (Object.keys(encryptedKeys).length > 0) {
      console.log('[Voice] distributing voice key to', Object.keys(encryptedKeys));
      ws.voiceKeyDistribute(teamId, channelId, keyId, encryptedKeys);
    } else {
      console.warn('[Voice] no recipients for voice key (peers:', Object.keys(peers), ')');
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
    if (!teamId || !channelId) {
      console.warn('[Voice] Missing teamId/channelId — rejecting voice key from', senderId);
      return;
    }

    let rawKey: Uint8Array;
    try {
      // unwrapForPeer is static-static ECDH — symmetrical with the
      // wrap path used in distributeVoiceKey. No Double Ratchet
      // session state needed, so it works even on a fresh first
      // contact between two peers in a voice channel.
      rawKey = await cryptoService.unwrapFromPeer(teamId, senderId, encryptedKey);
    } catch (err) {
      console.error('[Voice] Failed to unwrap voice key from', senderId, err);
      return;
    }

    await this.voiceKeyManager.setRemoteKey(senderId, rawKey);
    console.log('[Voice] received + installed voice key from', senderId, 'keyId=', keyId, 'into', this.decryptWorkers.size, 'workers');

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
