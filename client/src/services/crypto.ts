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
 * Called after passkey/recovery unlock.
 */
export async function initCrypto(keys: IdentityKeys, derivedKey: string): Promise<void> {
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
export type { PrekeyBundle };

/**
 * E2E encryption service. Uses pure TypeScript CryptoManager internally.
 * All functions accept `derivedKey` — the base64-encoded key used to persist sessions.
 */
export const cryptoService = {
  async generatePrekeyBundle(_derivedKey: string): Promise<PrekeyBundle> {
    const mgr = getManager();
    const bundle = await mgr.generatePrekeyBundle();
    return bundle;
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
    mgr.processSenderKey(channelId, distributionJson);
    await persistSessions(derivedKey);
  },

  async getSenderKeyDistribution(channelId: string, derivedKey: string): Promise<string> {
    const mgr = getManager();
    const userId = toBase64(getIdentityKeys().publicKeyBytes);
    const dist = await mgr.getSenderKeyDistribution(channelId, userId);
    await persistSessions(derivedKey);
    return dist;
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
        const bundle = await api.getPrekeyBundle(teamId, peerId);
        const bundleJson = JSON.stringify(bundle);
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
        await this.getSenderKeyDistribution(channelId, derivedKey);
        initializedSessions.add(key);
      } catch {
        // Don't mark as initialized — allow retry on next attempt
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
