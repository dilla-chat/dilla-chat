// ─── Crypto Manager ───────────────────────────────────────────────────────────

import { encoder, decoder, toBase64, fromBase64 } from './helpers';
import { generatePrekeyBundle } from './prekeys';
import type { PrekeyBundle, PrekeySecrets } from './prekeys';
import { x3dhInitiate, x3dhRespond } from './x3dh';
import { RatchetSession } from './ratchet';
import type { RatchetMessage, X3DHBootstrap } from './ratchet';
import { GroupSession } from './groupSession';
import type { GroupMessageData, SenderKeyDistribution } from './groupSession';
import { saveGroupSession, loadGroupSession } from './sessionStore';
import { generateSafetyNumber } from './safetyNumbers';
import { x25519DH, importX25519PrivateKey } from './x25519';
import { hkdfDerive } from './hkdf';
import { aesGcmEncrypt, aesGcmDecrypt } from './aesGcm';

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

  /** True if we have the X25519 privates needed to respond to an
   *  incoming X3DH handshake. False after a session-format upgrade
   *  wipes them — the user must regenerate + re-upload a bundle. */
  hasPrekeySecrets(): boolean {
    return this.prekeySecrets !== null;
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
    const { sharedSecret, ephemeralPublicKey, oneTimePreKeyIndex } =
      await x3dhInitiate(this.identityDhKeyPair.privateKey, bundle);
    // The first outbound message on this session must carry the X3DH
    // handshake info so the recipient can derive the same shared
    // secret via x3dhRespond → initBob, without a pre-existing
    // session. RatchetSession holds this in `pendingBootstrap` until
    // encrypt() attaches it to the first message header.
    const bootstrap: X3DHBootstrap = {
      identity_dh_key: Array.from(this.identityDhKeyPair.publicKeyBytes),
      ephemeral_key: Array.from(ephemeralPublicKey),
      one_time_prekey_index: oneTimePreKeyIndex,
    };
    const session = await RatchetSession.initAlice(
      sharedSecret,
      new Uint8Array(bundle.signed_prekey),
      bootstrap,
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
    const msg: RatchetMessage = JSON.parse(decoder.decode(fromBase64(ciphertext)));
    const existing = this.pairwiseSessions.get(senderId);

    // Fast path: existing session decrypts. This covers all messages
    // after the first one in a session.
    if (existing) {
      try {
        const plaintext = await existing.decrypt(msg);
        return decoder.decode(plaintext);
      } catch (err) {
        // If the message carries an X3DH bootstrap header, fall
        // through to the responder path — our existing session is
        // probably a stale Alice-session that competed with the
        // sender's. Otherwise re-throw.
        if (!msg.header.x3dh) throw err;
      }
    }

    // Bob-side bootstrap: this is the first message we've seen from
    // this peer in this session, and the header carries the X3DH info
    // we need to derive the same shared secret the sender used.
    if (!msg.header.x3dh) {
      throw new Error(`No session for peer ${senderId} and message has no X3DH bootstrap`);
    }
    const session = await this.bootstrapBobSession(msg.header.x3dh);
    this.pairwiseSessions.set(senderId, session);
    const plaintext = await session.decrypt(msg);
    return decoder.decode(plaintext);
  }

  /** Run x3dhRespond + initBob from an incoming first-message header.
   *  Requires our prekey secrets (signed_prekey + one_time_prekey
   *  privates) — these are persisted alongside the session store, so
   *  they survive page reloads and are restored by loadSessions(). */
  private async bootstrapBobSession(bootstrap: X3DHBootstrap): Promise<RatchetSession> {
    if (!this.prekeySecrets) {
      throw new Error('No prekey secrets — cannot respond to X3DH handshake');
    }
    const signedPrekeyPriv = await importX25519PrivateKey(this.prekeySecrets.signed_prekey_private);
    let otpkPriv: CryptoKey | null = null;
    if (bootstrap.one_time_prekey_index !== null) {
      const otpkBytes = this.prekeySecrets.one_time_prekey_privates[bootstrap.one_time_prekey_index];
      if (otpkBytes) {
        otpkPriv = await importX25519PrivateKey(otpkBytes);
      }
    }
    const sharedSecret = await x3dhRespond(
      this.identityDhKeyPair.privateKey,
      signedPrekeyPriv,
      new Uint8Array(bootstrap.identity_dh_key),
      new Uint8Array(bootstrap.ephemeral_key),
      otpkPriv,
    );
    return RatchetSession.initBob(sharedSecret, this.prekeySecrets.signed_prekey_private);
  }

  /** Wrap a short payload (e.g. a voice SFrame key) for a single peer
   *  using static-static ECDH between the two users' identity DH keys.
   *  This intentionally bypasses the Double Ratchet — sender and
   *  receiver derive the same shared secret deterministically, so
   *  this works without the X3DH "respond" handshake the ratchet
   *  would otherwise need on the recipient side. Lacks forward
   *  secrecy on the wrapper, but voice keys are session-scoped
   *  (regenerated per voice join) so the practical security envelope
   *  is the same. Used for voice:key-distribute. */
  async wrapForPeer(peerIdentityDhPub: Uint8Array, plaintext: Uint8Array): Promise<string> {
    const shared = await x25519DH(this.identityDhKeyPair.privateKey, peerIdentityDhPub);
    const wrapKey = await hkdfDerive(shared, encoder.encode('DillaPeerWrap'), 32, new Uint8Array(32));
    const ct = await aesGcmEncrypt(wrapKey, plaintext);
    return toBase64(ct);
  }

  async unwrapFromPeer(peerIdentityDhPub: Uint8Array, ciphertext: string): Promise<Uint8Array> {
    const shared = await x25519DH(this.identityDhKeyPair.privateKey, peerIdentityDhPub);
    const wrapKey = await hkdfDerive(shared, encoder.encode('DillaPeerWrap'), 32, new Uint8Array(32));
    return aesGcmDecrypt(wrapKey, fromBase64(ciphertext));
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
    // Previously this silently no-op'd when no local session existed yet,
    // which meant a peer's distribute that arrived *before* we'd created
    // our own session for the channel was dropped on the floor. With join
    // ordering being racy across freshly-registered users, that was the
    // root cause of "Unable to decrypt — previous session key" errors:
    // either side could miss the other's first distribute, after which
    // they each had a session but didn't have each other's sender key.
    //
    // Use our identity public key as the local sender id so the session
    // we create here matches what getSenderKeyDistribution would create.
    const ownSenderId = toBase64(this.identityPublicKeyBytes);
    const session = await this.getOrCreateGroupSession(channelId, ownSenderId);
    session.processDistribution(dist);
    await saveGroupSession(channelId, session.toJSON()).catch(() => {});
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

  /** Persisted-format version. Bump when changing the on-disk shape
   *  in a way that makes prior sessions undecryptable. loadSessions
   *  drops pairwise sessions + prekey secrets on mismatch (group
   *  sessions are sender-side only, so they remain valid). */
  static readonly SESSION_FORMAT_VERSION = 2;

  /** Serialize all sessions for encrypted storage */
  toJSON(): object {
    return {
      version: CryptoManager.SESSION_FORMAT_VERSION,
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

  /** Deserialize sessions from storage. Drops pairwise sessions +
   *  prekey secrets when the persisted version predates the X3DH
   *  bootstrap field — pre-v2 Alice-sessions are undecryptable by
   *  the peer because the receiver-side x3dhRespond has no header
   *  fields to read identity_dh / ephemeral / opk index from. Group
   *  sessions are sender-side and unaffected. */
  loadSessions(data: Record<string, unknown>): void {
    const persistedVersion = typeof data.version === 'number' ? (data.version as number) : 1;
    const stale = persistedVersion < CryptoManager.SESSION_FORMAT_VERSION;
    if (stale) {
      console.warn(
        `[crypto] Persisted session format v${persistedVersion} < current v${CryptoManager.SESSION_FORMAT_VERSION} — discarding pairwise sessions and prekey secrets`,
      );
    }
    const ps = data.pairwiseSessions as Record<string, Record<string, unknown>>;
    if (ps && !stale) {
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
    if (data.prekeySecrets && !stale) {
      const ps2 = data.prekeySecrets as Record<string, unknown>;
      this.prekeySecrets = {
        signed_prekey_private: new Uint8Array(ps2.signed_prekey_private as number[]),
        one_time_prekey_privates: (ps2.one_time_prekey_privates as number[][]).map(k => new Uint8Array(k)),
        identity_dh_private: new Uint8Array(ps2.identity_dh_private as number[]),
      };
    }
  }
}
