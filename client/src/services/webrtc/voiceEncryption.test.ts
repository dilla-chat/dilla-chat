// Tests for VoiceEncryptionManager — focuses on the early-return guards
// + cleanup + distribute branches that don't require RTCRtpScriptTransform
// (which jsdom doesn't implement).

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../websocket', () => ({
  ws: {
    voiceKeyDistribute: vi.fn(),
  },
}));

const peersByUser: Record<string, unknown> = {};
vi.mock('../../stores/voiceStore', () => ({
  useVoiceStore: {
    getState: () => ({ peers: peersByUser }),
  },
}));

vi.mock('../voiceCrypto', () => ({
  VoiceKeyManager: class {
    private localKey: Uint8Array | null = null;
    private localKeyId = 0;
    async generateLocalKey() {
      this.localKey = new Uint8Array(32);
      this.localKeyId = 1;
      return { rawKey: this.localKey, keyId: this.localKeyId };
    }
    getLocalRawKey() {
      return this.localKey;
    }
    getLocalKeyId() {
      return this.localKeyId;
    }
    async setRemoteKey() {
      /* no-op */
    }
    clear() {
      this.localKey = null;
    }
  },
}));

vi.mock('../crypto', () => ({
  cryptoService: {
    wrapForPeer: vi.fn(async () => 'wrapped-key-b64'),
    unwrapFromPeer: vi.fn(async () => new Uint8Array(32)),
  },
}));

import { VoiceEncryptionManager } from './voiceEncryption';
import { ws } from '../websocket';
import { cryptoService } from '../crypto';

beforeEach(() => {
  for (const k of Object.keys(peersByUser)) delete peersByUser[k];
  (ws.voiceKeyDistribute as ReturnType<typeof vi.fn>).mockClear();
  (cryptoService.wrapForPeer as ReturnType<typeof vi.fn>).mockClear();
  (cryptoService.unwrapFromPeer as ReturnType<typeof vi.fn>).mockClear();
});

describe('VoiceEncryptionManager.distributeVoiceKey', () => {
  it('no-ops when E2E is disabled', async () => {
    const mgr = new VoiceEncryptionManager();
    mgr.e2eEnabled = false;
    await mgr.distributeVoiceKey('t1', 'ch1', 'me');
    expect(ws.voiceKeyDistribute).not.toHaveBeenCalled();
  });

  it('no-ops when teamId or channelId is null', async () => {
    const mgr = new VoiceEncryptionManager();
    mgr.e2eEnabled = true;
    await mgr.distributeVoiceKey(null, 'ch1', 'me');
    await mgr.distributeVoiceKey('t1', null, 'me');
    expect(ws.voiceKeyDistribute).not.toHaveBeenCalled();
  });

  it('warns and does not distribute when no recipients', async () => {
    const mgr = new VoiceEncryptionManager();
    mgr.e2eEnabled = true;
    await mgr.voiceKeyManager.generateLocalKey();
    // Only the local user is in peers → after filter, no recipients remain.
    peersByUser['me'] = {};
    await mgr.distributeVoiceKey('t1', 'ch1', 'me');
    expect(ws.voiceKeyDistribute).not.toHaveBeenCalled();
  });

  it('distributes wrapped key to remote peers', async () => {
    const mgr = new VoiceEncryptionManager();
    mgr.e2eEnabled = true;
    await mgr.voiceKeyManager.generateLocalKey();
    peersByUser['me'] = {};
    peersByUser['u2'] = {};
    peersByUser['u3'] = {};
    await mgr.distributeVoiceKey('t1', 'ch1', 'me');
    expect(cryptoService.wrapForPeer).toHaveBeenCalledTimes(2);
    expect(ws.voiceKeyDistribute).toHaveBeenCalled();
  });

  it('tolerates wrap failures and continues with other peers', async () => {
    (cryptoService.wrapForPeer as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('no session for u2'))
      .mockResolvedValueOnce('ok-b64');
    const mgr = new VoiceEncryptionManager();
    mgr.e2eEnabled = true;
    await mgr.voiceKeyManager.generateLocalKey();
    peersByUser['u2'] = {};
    peersByUser['u3'] = {};
    await mgr.distributeVoiceKey('t1', 'ch1', 'me');
    // One peer succeeded → distribute fires with the surviving entry.
    expect(ws.voiceKeyDistribute).toHaveBeenCalled();
  });
});

describe('VoiceEncryptionManager.handleReceivedVoiceKey', () => {
  it('rejects when teamId is null', async () => {
    const mgr = new VoiceEncryptionManager();
    await mgr.handleReceivedVoiceKey('sender', 1, 'enc', null, 'ch1');
    expect(cryptoService.unwrapFromPeer).not.toHaveBeenCalled();
  });

  it('rejects when channelId is null', async () => {
    const mgr = new VoiceEncryptionManager();
    await mgr.handleReceivedVoiceKey('sender', 1, 'enc', 't1', null);
    expect(cryptoService.unwrapFromPeer).not.toHaveBeenCalled();
  });

  it('logs and bails when unwrap fails', async () => {
    (cryptoService.unwrapFromPeer as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('bad key'),
    );
    const mgr = new VoiceEncryptionManager();
    await mgr.handleReceivedVoiceKey('sender', 1, 'bad', 't1', 'ch1');
    // Doesn't throw — error is caught and logged.
    expect(cryptoService.unwrapFromPeer).toHaveBeenCalled();
  });

  it('installs the key on success even with no decrypt workers', async () => {
    const mgr = new VoiceEncryptionManager();
    await mgr.handleReceivedVoiceKey('sender', 7, 'good-enc', 't1', 'ch1');
    expect(cryptoService.unwrapFromPeer).toHaveBeenCalled();
  });
});

describe('VoiceEncryptionManager.cleanup', () => {
  it('clears state without crashing on a fresh manager', () => {
    const mgr = new VoiceEncryptionManager();
    mgr.e2eEnabled = true;
    mgr.cleanup();
    expect(mgr.e2eEnabled).toBe(false);
  });
});
