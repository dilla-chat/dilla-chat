import { api } from './api';
import {
  CryptoManager,
  fromBase64,
  toBase64,
  type PrekeyBundle,
} from './cryptoCore';
import {
  saveSessions,
  loadSessions,
  type IdentityKeys,
} from './keyStore';

// ─── Singleton CryptoManager ─────────────────────────────────────────────────

let manager: CryptoManager | null = null;
let identityKeys: IdentityKeys | null = null;

// Track which peers/channels have initialized sessions
const initializedSessions = new Set<string>();
const initializingPromises = new Map<string, Promise<void>>();

/**
 * Initialize the crypto service with unlocked identity keys.
 * Called after passkey/recovery unlock. Idempotent — skips if already
 * initialized to avoid overwriting in-memory session state.
 */
/** Clear the crypto manager on logout so initCrypto can re-initialize. */
export function resetCrypto(): void {
  manager = null;
  identityKeys = null;
  initializedSessions.clear();
}

/** True if `initCrypto` has been called successfully. */
export function isCryptoInitialized(): boolean {
  return manager !== null;
}

export async function initCrypto(keys: IdentityKeys, derivedKey: string): Promise<void> {
  if (manager) {
    console.log('[crypto] Already initialized, skipping duplicate initCrypto');
    return;
  }
  identityKeys = keys;
  manager = new CryptoManager(
    keys.signingKey,
    keys.publicKeyBytes,
    { privateKey: keys.dhKeyPair.privateKey, publicKeyBytes: keys.dhKeyPair.publicKeyBytes },
  );

  // Restore persisted sessions
  try {
    const saved = await loadSessions(derivedKey);
    if (saved) {
      manager.loadSessions(saved as Record<string, unknown>);
      const groupCount = manager.groupSessions.size;
      console.log(`[crypto] Restored ${groupCount} group sessions from IndexedDB`);
    } else {
      console.log('[crypto] No persisted sessions found in IndexedDB');
    }
  } catch (e) {
    console.warn('[crypto] Failed to restore sessions:', e);
  }
}

/** Get the CryptoManager (throws if not initialized) */
function getManager(): CryptoManager {
  if (!manager) throw new Error('Crypto not initialized — call initCrypto() first');
  return manager;
}

/** Get the identity keys (throws if not initialized) */
export function getIdentityKeys(): IdentityKeys {
  if (!identityKeys) throw new Error('Crypto not initialized — call initCrypto() first');
  return identityKeys;
}

/** Persist current sessions to IndexedDB */
async function persistSessions(derivedKey: string): Promise<void> {
  if (!manager) return;
  try {
    await saveSessions(manager.toJSON(), derivedKey);
  } catch (e) {
    console.warn('[crypto] Failed to persist sessions:', e);
  }
}

// Re-export PrekeyBundle type for consumers
export type { PrekeyBundle } from './cryptoCore';

/**
 * E2E encryption service. Uses pure TypeScript CryptoManager internally.
 * All functions accept `derivedKey` — the base64-encoded key used to persist sessions.
 */
export const cryptoService = {
  async generatePrekeyBundle(derivedKey: string): Promise<PrekeyBundle> {
    const mgr = getManager();
    const bundle = await mgr.generatePrekeyBundle();
    // Persist the secrets so Bob's X3DH-respond path can find the
    // matching signed_prekey_private and one_time_prekey_privates
    // after a reload. Without this, an incoming first-message would
    // arrive after a fresh page load with no way to derive the
    // shared secret.
    await persistSessions(derivedKey);
    return bundle;
  },

  /** Whether local prekey secrets exist. False right after a
   *  session-format upgrade (which discards them) — the prekey
   *  backfill should regenerate + re-upload in that case so the
   *  server's published bundle matches our local privates. */
  hasPrekeySecrets(): boolean {
    return getManager().hasPrekeySecrets();
  },

  async encryptMessage(
    peerId: string,
    plaintext: string,
    isDm: boolean,
    channelId: string,
    derivedKey: string,
  ): Promise<string> {
    const mgr = getManager();
    let result: string;
    if (isDm) {
      result = await mgr.encryptDM(peerId, plaintext);
    } else {
      result = await mgr.encryptChannel(channelId, peerId, plaintext);
    }
    await persistSessions(derivedKey);
    return result;
  },

  async decryptMessage(
    senderId: string,
    ciphertext: string,
    isDm: boolean,
    channelId: string,
    derivedKey: string,
  ): Promise<string> {
    const mgr = getManager();
    let result: string;
    if (isDm) {
      result = await mgr.decryptDM(senderId, ciphertext);
    } else {
      result = await mgr.decryptChannel(channelId, senderId, ciphertext);
    }
    await persistSessions(derivedKey);
    return result;
  },

  async initSession(peerId: string, bundleJson: string, derivedKey: string): Promise<void> {
    const mgr = getManager();
    const bundle: PrekeyBundle = JSON.parse(bundleJson);
    await mgr.initSessionWithBundle(peerId, bundle);
    await persistSessions(derivedKey);
  },

  async getSafetyNumber(
    peerId: string,
    peerPublicKey: string,
    _derivedKey: string,
  ): Promise<string> {
    const mgr = getManager();
    const pubBytes = fromBase64(peerPublicKey);
    return mgr.getSafetyNumber(peerId, pubBytes);
  },

  async processSenderKey(
    channelId: string,
    distributionJson: string,
    derivedKey: string,
  ): Promise<void> {
    const mgr = getManager();
    await mgr.processSenderKey(channelId, distributionJson);
    await persistSessions(derivedKey);
  },

  /** Rotate the sender key for a channel after a member leaves.
   *  Returns the new distribution message to send to remaining members. */
  async rotateChannelKey(channelId: string, removedUserId: string, derivedKey: string): Promise<string | null> {
    const mgr = getManager();
    const result = await mgr.rotateChannelKey(channelId, removedUserId);
    await persistSessions(derivedKey);
    return result;
  },

  async getSenderKeyDistribution(channelId: string, derivedKey: string): Promise<string> {
    const mgr = getManager();
    const userId = toBase64(getIdentityKeys().publicKeyBytes);
    const dist = await mgr.getSenderKeyDistribution(channelId, userId);
    await persistSessions(derivedKey);
    return dist;
  },

  /** Static-static ECDH wrap a short payload for a peer (used for
   *  voice SFrame key distribution). Both sender and receiver derive
   *  the same wrap key from their identity DH keys, so this works
   *  without a Double Ratchet session — which the current codebase
   *  can't bootstrap on the receiver side (no x3dhRespond). */
  async wrapForPeer(teamId: string, peerId: string, plaintext: Uint8Array): Promise<string> {
    const wire = await api.getPrekeyBundle(teamId, peerId);
    const peerDh = new Uint8Array(
      atob(wire.identity_dh_key)
        .split('')
        .map((c) => c.codePointAt(0)!),
    );
    const mgr = getManager();
    return mgr.wrapForPeer(peerDh, plaintext);
  },

  async unwrapFromPeer(teamId: string, peerId: string, ciphertext: string): Promise<Uint8Array> {
    const wire = await api.getPrekeyBundle(teamId, peerId);
    const peerDh = new Uint8Array(
      atob(wire.identity_dh_key)
        .split('')
        .map((c) => c.codePointAt(0)!),
    );
    const mgr = getManager();
    return mgr.unwrapFromPeer(peerDh, ciphertext);
  },

  async ensurePeerSession(
    teamId: string,
    peerId: string,
    derivedKey: string,
  ): Promise<void> {
    const key = `peer:${peerId}`;
    if (initializedSessions.has(key)) return;

    const existing = initializingPromises.get(key);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const wire = await api.getPrekeyBundle(teamId, peerId);
        // The wire format is base64 strings; the PrekeyBundle the
        // crypto layer consumes expects raw byte arrays. Doing
        // `new Uint8Array(base64String)` (which is what x3dhInitiate
        // would otherwise hit) doesn't decode — it just iterates char
        // codes — producing a buffer of the wrong length that
        // WebCrypto rejects with "Data provided to an operation does
        // not meet requirements". Decode here once at the boundary.
        const b64 = (s: string): number[] =>
          Array.from(atob(s), (c) => c.codePointAt(0)!);
        const decoded = {
          identity_key: b64(wire.identity_key),
          identity_dh_key: b64(wire.identity_dh_key),
          signed_prekey: b64(wire.signed_prekey),
          signed_prekey_signature: b64(wire.signed_prekey_signature),
          one_time_prekeys: wire.one_time_prekeys.map(b64),
        };
        const bundleJson = JSON.stringify(decoded);
        await this.initSession(peerId, bundleJson, derivedKey);
        initializedSessions.add(key);
      } finally {
        initializingPromises.delete(key);
      }
    })();

    initializingPromises.set(key, promise);
    return promise;
  },

  async encryptDM(
    teamId: string,
    peerId: string,
    plaintext: string,
    channelId: string,
    derivedKey: string,
  ): Promise<string> {
    await this.ensurePeerSession(teamId, peerId, derivedKey);
    return this.encryptMessage(peerId, plaintext, true, channelId, derivedKey);
  },

  async decryptDM(
    teamId: string,
    senderId: string,
    ciphertext: string,
    channelId: string,
    derivedKey: string,
  ): Promise<string> {
    await this.ensurePeerSession(teamId, senderId, derivedKey);
    return this.decryptMessage(senderId, ciphertext, true, channelId, derivedKey);
  },

  async ensureChannelSession(
    channelId: string,
    _userId: string,
    derivedKey: string,
  ): Promise<void> {
    const key = `channel:${channelId}`;
    if (initializedSessions.has(key)) return;

    const existing = initializingPromises.get(key);
    if (existing) return existing;

    const promise = (async () => {
      try {
        // Check if a session already exists (in memory or IndexedDB) before
        // creating a new one. getSenderKeyDistribution creates a fresh session
        // with new random keys, which would destroy any persisted session.
        const mgr = getManager();
        const existingSession = mgr.groupSessions.get(channelId);
        if (!existingSession) {
          const { loadGroupSession } = await import('./crypto/sessionStore');
          const stored = await loadGroupSession(channelId);
          if (stored) {
            const { GroupSession } = await import('./crypto/groupSession');
            const restored = GroupSession.fromJSON(stored);
            mgr.groupSessions.set(channelId, restored);
            console.log(`[Crypto] Restored existing session for ${channelId} from IndexedDB`);
          } else {
            // No existing session — create fresh
            await this.getSenderKeyDistribution(channelId, derivedKey);
            console.log(`[Crypto] Created new session for ${channelId}`);
          }
        }
        initializedSessions.add(key);
      } catch (err) {
        console.warn(`[Crypto] ensureChannelSession failed for ${channelId}:`, err);
      } finally {
        initializingPromises.delete(key);
      }
    })();

    initializingPromises.set(key, promise);
    return promise;
  },

  async encryptChannel(
    channelId: string,
    userId: string,
    plaintext: string,
    derivedKey: string,
  ): Promise<string> {
    await this.ensureChannelSession(channelId, userId, derivedKey);
    return this.encryptMessage(channelId, plaintext, false, channelId, derivedKey);
  },

  async decryptChannel(
    channelId: string,
    userId: string,
    senderId: string,
    ciphertext: string,
    derivedKey: string,
  ): Promise<string> {
    await this.ensureChannelSession(channelId, userId, derivedKey);
    return this.decryptMessage(senderId, ciphertext, false, channelId, derivedKey);
  },
};
