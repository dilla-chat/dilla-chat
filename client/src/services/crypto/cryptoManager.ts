// ─── Crypto Manager ───────────────────────────────────────────────────────────

import { encoder, decoder, toBase64, fromBase64 } from './helpers';
import { generatePrekeyBundle } from './prekeys';
import type { PrekeyBundle, PrekeySecrets } from './prekeys';
import { x3dhInitiate } from './x3dh';
import { RatchetSession } from './ratchet';
import type { RatchetMessage } from './ratchet';
import { GroupSession } from './groupSession';
import type { GroupMessageData, SenderKeyDistribution } from './groupSession';
import { saveGroupSession, loadGroupSession } from './sessionStore';
import { generateSafetyNumber } from './safetyNumbers';

export class CryptoManager {
  private readonly identitySigningKey: CryptoKey;
  private readonly identityPublicKeyBytes: Uint8Array;
  private readonly identityDhKeyPair: { privateKey: CryptoKey; publicKeyBytes: Uint8Array };
  private prekeySecrets: PrekeySecrets | null = null;
  private readonly pairwiseSessions: Map<string, RatchetSession> = new Map();
  readonly groupSessions: Map<string, GroupSession> = new Map();

  constructor(
    signingKey: CryptoKey,
    publicKeyBytes: Uint8Array,
    dhKeyPair: { privateKey: CryptoKey; publicKeyBytes: Uint8Array },
  ) {
    this.identitySigningKey = signingKey;
    this.identityPublicKeyBytes = publicKeyBytes;
    this.identityDhKeyPair = dhKeyPair;
  }

  setPrekeySecrets(secrets: PrekeySecrets): void {
    this.prekeySecrets = secrets;
  }

  async generatePrekeyBundle(numOneTimePrekeys = 10): Promise<PrekeyBundle> {
    const { bundle, secrets } = await generatePrekeyBundle(
      this.identitySigningKey,
      { privateKey: this.identityDhKeyPair.privateKey, publicKey: null as unknown as CryptoKey, publicKeyBytes: this.identityDhKeyPair.publicKeyBytes },
      numOneTimePrekeys,
    );
    this.prekeySecrets = secrets;
    return bundle;
  }

  async initSessionWithBundle(peerId: string, bundle: PrekeyBundle): Promise<void> {
    if (this.pairwiseSessions.has(peerId)) return;
    const { sharedSecret } = await x3dhInitiate(
      this.identityDhKeyPair.privateKey,
      bundle,
    );
    const session = await RatchetSession.initAlice(
      sharedSecret,
      new Uint8Array(bundle.signed_prekey),
    );
    this.pairwiseSessions.set(peerId, session);
  }

  async encryptDM(peerId: string, plaintext: string): Promise<string> {
    const session = this.pairwiseSessions.get(peerId);
    if (!session) throw new Error(`No session for peer ${peerId}`);
    const msg = await session.encrypt(encoder.encode(plaintext));
    return toBase64(encoder.encode(JSON.stringify(msg)));
  }

  async decryptDM(senderId: string, ciphertext: string): Promise<string> {
    const session = this.pairwiseSessions.get(senderId);
    if (!session) throw new Error(`No session for peer ${senderId}`);
    const msg: RatchetMessage = JSON.parse(decoder.decode(fromBase64(ciphertext)));
    const plaintext = await session.decrypt(msg);
    return decoder.decode(plaintext);
  }

  async getOrCreateGroupSession(channelId: string, senderId: string): Promise<GroupSession> {
    let session = this.groupSessions.get(channelId);
    if (!session) {
      // Try to restore from encrypted IndexedDB first
      const stored = await loadGroupSession(channelId);
      if (stored) {
        try {
          session = GroupSession.fromJSON(stored);
          this.groupSessions.set(channelId, session);
          console.log(`[Crypto] Restored session for ${channelId} from IndexedDB (msg# ${session.mySenderKey.messageNumber}, members: ${session.memberSenderKeys.size})`);
          return session;
        } catch (err) {
          console.warn(`[Crypto] Failed to restore session for ${channelId}:`, err);
        }
      } else {
        console.log(`[Crypto] No stored session for ${channelId}, creating fresh`);
      }
      session = await GroupSession.create(channelId, senderId);
      this.groupSessions.set(channelId, session);
      // Persist the new session
      await saveGroupSession(channelId, session.toJSON()).catch(() => {});
    }
    return session;
  }

  async encryptChannel(channelId: string, senderId: string, plaintext: string): Promise<string> {
    const session = await this.getOrCreateGroupSession(channelId, senderId);
    const msg = await session.encrypt(encoder.encode(plaintext));
    // Persist updated chain state after encrypt advances the ratchet
    await saveGroupSession(channelId, session.toJSON()).catch(() => {});
    return toBase64(encoder.encode(JSON.stringify(msg)));
  }

  async decryptChannel(channelId: string, _senderId: string, ciphertext: string): Promise<string> {
    let session = this.groupSessions.get(channelId);
    if (!session) {
      // Try to restore from IndexedDB
      const stored = await loadGroupSession(channelId);
      if (stored) {
        try {
          session = GroupSession.fromJSON(stored);
          this.groupSessions.set(channelId, session);
        } catch {
          throw new Error(`No group session for channel ${channelId}`);
        }
      } else {
        throw new Error(`No group session for channel ${channelId}`);
      }
    }
    const msg: GroupMessageData = JSON.parse(decoder.decode(fromBase64(ciphertext)));
    const plaintext = await session.decrypt(msg);
    // Persist updated chain state after decrypt advances the ratchet
    await saveGroupSession(channelId, session.toJSON()).catch(() => {});
    return decoder.decode(plaintext);
  }

  /** Remove a member from a channel's group session and rotate our sender key.
   *  Returns a new distribution message to send to remaining members, or null
   *  if no group session exists for this channel. */
  async rotateChannelKey(channelId: string, removedUserId: string): Promise<string | null> {
    const session = this.groupSessions.get(channelId);
    if (!session) return null;
    session.removeMember(removedUserId);
    await session.rotateMyKey();
    await saveGroupSession(channelId, session.toJSON()).catch(() => {});
    return JSON.stringify(session.createDistributionMessage());
  }

  async processSenderKey(channelId: string, distributionJson: string): Promise<void> {
    const dist: SenderKeyDistribution = JSON.parse(distributionJson);
    const session = this.groupSessions.get(channelId);
    if (session) {
      session.processDistribution(dist);
      await saveGroupSession(channelId, session.toJSON()).catch(() => {});
    }
  }

  async getSenderKeyDistribution(channelId: string, senderId: string): Promise<string> {
    const session = await this.getOrCreateGroupSession(channelId, senderId);
    return JSON.stringify(session.createDistributionMessage());
  }

  async getSafetyNumber(peerId: string, peerPublicKey: Uint8Array): Promise<string> {
    return generateSafetyNumber(
      this.identityPublicKeyBytes,
      'self',
      peerPublicKey,
      peerId,
    );
  }

  /** Serialize all sessions for encrypted storage */
  toJSON(): object {
    return {
      pairwiseSessions: Object.fromEntries(
        [...this.pairwiseSessions.entries()].map(([k, v]) => [k, v.toJSON()]),
      ),
      groupSessions: Object.fromEntries(
        [...this.groupSessions.entries()].map(([k, v]) => [k, v.toJSON()]),
      ),
      prekeySecrets: this.prekeySecrets ? {
        signed_prekey_private: Array.from(this.prekeySecrets.signed_prekey_private),
        one_time_prekey_privates: this.prekeySecrets.one_time_prekey_privates.map(k => Array.from(k)),
        identity_dh_private: Array.from(this.prekeySecrets.identity_dh_private),
      } : null,
    };
  }

  /** Deserialize sessions from storage */
  loadSessions(data: Record<string, unknown>): void {
    const ps = data.pairwiseSessions as Record<string, Record<string, unknown>>;
    if (ps) {
      for (const [k, v] of Object.entries(ps)) {
        this.pairwiseSessions.set(k, RatchetSession.fromJSON(v));
      }
    }
    const gs = data.groupSessions as Record<string, Record<string, unknown>>;
    if (gs) {
      for (const [k, v] of Object.entries(gs)) {
        this.groupSessions.set(k, GroupSession.fromJSON(v));
      }
    }
    if (data.prekeySecrets) {
      const ps2 = data.prekeySecrets as Record<string, unknown>;
      this.prekeySecrets = {
        signed_prekey_private: new Uint8Array(ps2.signed_prekey_private as number[]),
        one_time_prekey_privates: (ps2.one_time_prekey_privates as number[][]).map(k => new Uint8Array(k)),
        identity_dh_private: new Uint8Array(ps2.identity_dh_private as number[]),
      };
    }
  }
}
