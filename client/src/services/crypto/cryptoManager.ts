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
// F3 — safetyNumberInWorker dispatches into the crypto Web Worker so
// CPU-bound SHA-256 ×5200 doesn't block the main thread, and so the
// (eventual) ratchet-key consumers in the worker have a battle-tested
// RPC pipeline to lean on. See architecture review §8.4 bullet 1.
import {
  safetyNumberInWorker,
  getCryptoBackend,
  groupSessionEncryptInWorker,
  groupSessionDecryptInWorker,
  groupSessionProcessDistributionInWorker,
  groupSessionRotateMyKeyInWorker,
  groupSessionGetDistributionInWorker,
  pairwiseSessionSaveInWorker,
  pairwiseSessionEncryptInWorker,
  pairwiseSessionDecryptInWorker,
  identityInitInWorker,
  isIdentityInitInWorker,
  wrapForPeerInWorker,
  unwrapFromPeerInWorker,
  prekeyVaultSaveInWorker,
  pairwiseSessionBootstrapAliceInWorker,
  pairwiseSessionBootstrapBobInWorker,
} from './workerClient';
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
    // H-12d.2: when the worker path is up, run X3DH initiate +
    // RatchetSession.initAlice inside the worker. The shared secret
    // + the new chain key never enter the main heap.
    if (await this.ensureIdentityInWorker()) {
      try {
        await pairwiseSessionBootstrapAliceInWorker(
          peerId,
          bundle as unknown as Record<string, unknown>,
        );
        // Worker is the source of truth now; we deliberately don't
        // mirror the session into pairwiseSessions Map (backend
        // routing in encryptDM/decryptDM already prefers the worker).
        return;
      } catch (err) {
        // Worker failed (e.g. peer bundle malformed, OS-level
        // postMessage failure) — fall through to the in-thread
        // path below so the call doesn't hard-fail.
        console.warn('[crypto] worker X3DH initiate failed; falling back to main thread', err);
      }
    }
    const { sharedSecret, ephemeralPublicKey, oneTimePreKeyIndex } =
      await x3dhInitiate(this.identityDhKeyPair.privateKey, bundle);
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
    if (this.useWorkerGroupSession()) {
      await pairwiseSessionSaveInWorker(peerId, session.toJSON()).catch(() => {});
    }
  }

  async encryptDM(peerId: string, plaintext: string): Promise<string> {
    // H-12c: encrypt in the worker when backend='worker'. The
    // chain key + per-message AES-GCM derive never touch main heap.
    if (this.useWorkerGroupSession()) {
      const plaintextB64 = toBase64(encoder.encode(plaintext));
      try {
        return await pairwiseSessionEncryptInWorker(peerId, plaintextB64);
      } catch (err) {
        // The worker may not have this session yet (e.g. it was
        // created via X3DH respond inside decryptDM but never
        // pushed; or the worker spawned after the session was
        // bootstrapped). Fall through to the in-thread path with a
        // best-effort save back to the worker so future encrypts
        // catch up.
        const session = this.pairwiseSessions.get(peerId);
        if (!session) throw err;
        const msg = await session.encrypt(encoder.encode(plaintext));
        pairwiseSessionSaveInWorker(peerId, session.toJSON()).catch(() => {});
        return toBase64(encoder.encode(JSON.stringify(msg)));
      }
    }
    const session = this.pairwiseSessions.get(peerId);
    if (!session) throw new Error(`No session for peer ${peerId}`);
    const msg = await session.encrypt(encoder.encode(plaintext));
    return toBase64(encoder.encode(JSON.stringify(msg)));
  }

  /** Try to decrypt a DM via the worker — including a worker-side Bob
   *  bootstrap retry when the first decrypt reports needsBootstrap.
   *  Returns the plaintext on success or `null` when the caller should
   *  fall back to the main-thread path. */
  private async tryDecryptDMInWorker(
    senderId: string,
    ciphertext: string,
  ): Promise<string | null> {
    try {
      const result = await pairwiseSessionDecryptInWorker(senderId, ciphertext);
      if (result.ok) {
        return decoder.decode(fromBase64(result.plaintextB64));
      }
      // result.ok === false → needsBootstrap. Try the worker-side Bob
      // bootstrap, then retry decrypt.
      const haveWorkerKeys =
        (await this.ensureIdentityInWorker()) &&
        (await this.ensurePrekeyVaultInWorker());
      if (!haveWorkerKeys) return null;
      const msg = JSON.parse(decoder.decode(fromBase64(ciphertext))) as RatchetMessage;
      if (!msg.header.x3dh) return null;
      try {
        await pairwiseSessionBootstrapBobInWorker(senderId, msg.header.x3dh);
        const retry = await pairwiseSessionDecryptInWorker(senderId, ciphertext);
        if (retry.ok) {
          return decoder.decode(fromBase64(retry.plaintextB64));
        }
      } catch (err) {
        console.warn('[crypto] worker Bob bootstrap failed; falling back', err);
      }
      return null;
    } catch (err) {
      const msg = JSON.parse(decoder.decode(fromBase64(ciphertext))) as RatchetMessage;
      if (!msg.header.x3dh) throw err;
      return null;
    }
  }

  async decryptDM(senderId: string, ciphertext: string): Promise<string> {
    // H-12c: try the worker first. If it reports the message needs
    // an X3DH bootstrap (no session yet, or stale Alice-session),
    // H-12d.2 runs the Bob-bootstrap IN THE WORKER too (via the
    // prekey vault + identity DH key cached there), then retries.
    // Falls back to the main-thread bootstrap path on any worker
    // failure.
    if (this.useWorkerGroupSession()) {
      const workerResult = await this.tryDecryptDMInWorker(senderId, ciphertext);
      if (workerResult !== null) return workerResult;
    }

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
    // H-12c: ship the newly-bootstrapped session to the worker so
    // subsequent encrypt/decrypt ride the worker path.
    if (this.useWorkerGroupSession()) {
      pairwiseSessionSaveInWorker(senderId, session.toJSON()).catch(() => {});
    }
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
    // H-12d.1: when backend='worker', the identity DH private key
    // has been postMessage'd to the worker once and the wrap op
    // runs there. The CryptoKey is non-extractable so even though
    // both threads still hold a reference, the raw bytes never
    // become JS-readable. Main thread keeps its copy for
    // backend='main' fallback + the X3DH paths that haven't
    // migrated yet (H-12d.2).
    if (await this.ensureIdentityInWorker()) {
      return wrapForPeerInWorker(peerIdentityDhPub, plaintext);
    }
    const shared = await x25519DH(this.identityDhKeyPair.privateKey, peerIdentityDhPub);
    const wrapKey = await hkdfDerive(shared, encoder.encode('DillaPeerWrap'), 32, new Uint8Array(32));
    const ct = await aesGcmEncrypt(wrapKey, plaintext);
    return toBase64(ct);
  }

  async unwrapFromPeer(peerIdentityDhPub: Uint8Array, ciphertext: string): Promise<Uint8Array> {
    if (await this.ensureIdentityInWorker()) {
      return unwrapFromPeerInWorker(peerIdentityDhPub, fromBase64(ciphertext));
    }
    const shared = await x25519DH(this.identityDhKeyPair.privateKey, peerIdentityDhPub);
    const wrapKey = await hkdfDerive(shared, encoder.encode('DillaPeerWrap'), 32, new Uint8Array(32));
    return aesGcmDecrypt(wrapKey, fromBase64(ciphertext));
  }

  /** H-12d.1 / H-12d.2: lazy ship the identity DH private key + the
   *  public-key bytes (so the worker's X3DH initiate path can
   *  stamp them into the bootstrap header) to the worker. Idempotent
   *  on the worker-side init flag. Returns true when the worker
   *  path is ready (backend='worker', Worker available, init
   *  succeeded). */
  private async ensureIdentityInWorker(): Promise<boolean> {
    if (!this.useWorkerGroupSession()) return false;
    if (isIdentityInitInWorker()) return true;
    try {
      await identityInitInWorker(
        this.identityDhKeyPair.privateKey,
        this.identityDhKeyPair.publicKeyBytes,
      );
      return isIdentityInitInWorker();
    } catch {
      return false;
    }
  }

  /** H-12d.2: ship the prekey privates to the worker vault once after
   *  generation. The main thread can then drop its in-memory copy
   *  (we keep it for the backend='main' fallback). */
  private async shipPrekeySecretsToWorker(): Promise<void> {
    if (!this.useWorkerGroupSession() || !this.prekeySecrets) return;
    try {
      await prekeyVaultSaveInWorker(
        this.prekeySecrets.signed_prekey_private,
        this.prekeySecrets.one_time_prekey_privates,
      );
      this.prekeyVaultShipped = true;
    } catch (err) {
      console.warn('[crypto] prekey vault ship failed; X3DH respond will fall back', err);
    }
  }

  /** True once the prekey privates have been shipped to the worker
   *  via `shipPrekeySecretsToWorker`. */
  private prekeyVaultShipped = false;

  /** H-12d.2: ensure the worker has the prekey privates before
   *  calling pairwiseSession.bootstrapBob. Lazy ship on first need.
   *  Returns true when the vault is populated worker-side. */
  private async ensurePrekeyVaultInWorker(): Promise<boolean> {
    if (this.prekeyVaultShipped) return true;
    if (!this.useWorkerGroupSession()) return false;
    if (!this.prekeySecrets) return false;
    await this.shipPrekeySecretsToWorker();
    return this.prekeyVaultShipped;
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
    // H-12b: when backend='worker', the GroupSession state lives in
    // worker scope — load, mutate, save all happen there. The main
    // thread never holds the chain key for this op. Falls back to
    // the in-thread path for backend='main' (tests).
    if (this.useWorkerGroupSession()) {
      const plaintextB64 = toBase64(encoder.encode(plaintext));
      return groupSessionEncryptInWorker(channelId, senderId, plaintextB64);
    }
    const session = await this.getOrCreateGroupSession(channelId, senderId);
    const msg = await session.encrypt(encoder.encode(plaintext));
    await saveGroupSession(channelId, session.toJSON()).catch(() => {});
    return toBase64(encoder.encode(JSON.stringify(msg)));
  }

  async decryptChannel(channelId: string, _senderId: string, ciphertext: string): Promise<string> {
    // H-12b: worker path returns the plaintext as base64 so chain
    // state never enters the main heap.
    if (this.useWorkerGroupSession()) {
      const plaintextB64 = await groupSessionDecryptInWorker(channelId, ciphertext);
      return decoder.decode(fromBase64(plaintextB64));
    }
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
    await saveGroupSession(channelId, session.toJSON()).catch(() => {});
    return decoder.decode(plaintext);
  }

  /** H-12b: cached predicate for the worker backend selection. The
   *  decision must be consistent across one full encrypt → server
   *  echo → decrypt round-trip; flipping mid-message would diverge
   *  the worker's session cache from the main-thread one. We snap
   *  on construction (via the static helper) and don't re-read. */
  private useWorkerGroupSession(): boolean {
    return getCryptoBackend() === 'worker' && typeof Worker !== 'undefined';
  }

  /** Remove a member from a channel's group session and rotate our sender key.
   *  Returns a new distribution message to send to remaining members, or null
   *  if no group session exists for this channel. */
  async rotateChannelKey(channelId: string, removedUserId: string): Promise<string | null> {
    // H-12b: rotation happens in worker scope so the freshly-derived
    // chain key never crosses postMessage.
    if (this.useWorkerGroupSession()) {
      return groupSessionRotateMyKeyInWorker(channelId, removedUserId);
    }
    const session = this.groupSessions.get(channelId);
    if (!session) return null;
    session.removeMember(removedUserId);
    await session.rotateMyKey();
    await saveGroupSession(channelId, session.toJSON()).catch(() => {});
    return JSON.stringify(session.createDistributionMessage());
  }

  async processSenderKey(channelId: string, distributionJson: string): Promise<void> {
    // H-12b: peer's distribution payload is applied in worker scope.
    const ownSenderId = toBase64(this.identityPublicKeyBytes);
    if (this.useWorkerGroupSession()) {
      await groupSessionProcessDistributionInWorker(channelId, ownSenderId, distributionJson);
      return;
    }
    const dist: SenderKeyDistribution = JSON.parse(distributionJson);
    // Previously this silently no-op'd when no local session existed yet,
    // which meant a peer's distribute that arrived *before* we'd created
    // our own session for the channel was dropped on the floor. With join
    // ordering being racy across freshly-registered users, that was the
    // root cause of "Unable to decrypt — previous session key" errors:
    // either side could miss the other's first distribute, after which
    // they each had a session but didn't have each other's sender key.
    const session = await this.getOrCreateGroupSession(channelId, ownSenderId);
    session.processDistribution(dist);
    await saveGroupSession(channelId, session.toJSON()).catch(() => {});
  }

  async getSenderKeyDistribution(channelId: string, senderId: string): Promise<string> {
    // H-12b: distribution payloads carry the worker-derived public
    // chain-key + signing pubkey — getting them from the worker
    // means the corresponding secret half never leaves the worker.
    if (this.useWorkerGroupSession()) {
      return groupSessionGetDistributionInWorker(channelId, senderId);
    }
    const session = await this.getOrCreateGroupSession(channelId, senderId);
    return JSON.stringify(session.createDistributionMessage());
  }

  async getSafetyNumber(peerId: string, peerPublicKey: Uint8Array): Promise<string> {
    // F3 — first migrated crypto op. Falls back to the in-thread impl
    // automatically when Workers are unavailable (SSR/tests) or when
    // CRYPTO_BACKEND='main' is set. Inputs are public identity keys; no
    // secret material crosses postMessage.
    try {
      return await safetyNumberInWorker(
        this.identityPublicKeyBytes,
        'self',
        peerPublicKey,
        peerId,
      );
    } catch {
      // Worker pipeline broke — fall through to the in-thread copy
      // so the UI still renders a safety number rather than erroring.
      return generateSafetyNumber(
        this.identityPublicKeyBytes,
        'self',
        peerPublicKey,
        peerId,
      );
    }
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
    const persistedVersion = typeof data.version === 'number' ? data.version : 1;
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
