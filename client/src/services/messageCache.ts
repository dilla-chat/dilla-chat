/**
 * messageCache.ts — Encrypted local message cache in IndexedDB
 *
 * Caches decrypted message content locally so that messages don't need
 * to be re-decrypted from the server. This solves the forward-ratchet
 * problem where Sender Key chain advances make old ciphertext undecryptable.
 *
 * Plaintext is encrypted at rest using AES-GCM with a key derived from
 * the user's derivedKey (HKDF). If no derivedKey is available, caching
 * is skipped entirely — no plaintext is stored unencrypted.
 */

import { useAuthStore } from '../stores/authStore';

const DB_NAME = 'dilla-messages';
const DB_VERSION = 1;
const STORE_NAME = 'messages';

interface CachedMessage {
  id: string;
  channelId: string;
  /** AES-GCM encrypted plaintext (base64) — never stored unencrypted */
  ciphertext: string;
  cachedAt: number;
}

// ── Cache encryption helpers ────────────────────────────────────────────────

/** Derive a 256-bit AES-GCM key from the user's derivedKey for cache encryption. */
async function deriveCacheKey(derivedKey: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(derivedKey),
    'HKDF',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('dilla-msg-cache-v1'), info: encoder.encode('cache-encryption') },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypt plaintext for cache storage. Returns base64(iv + ciphertext). */
async function encryptForCache(plaintext: string, cacheKey: CryptoKey): Promise<string> {
  const encoder = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    cacheKey,
    encoder.encode(plaintext),
  );
  const combined = new Uint8Array(12 + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), 12);
  return btoa(String.fromCharCode(...combined));
}

/** Decrypt cache ciphertext. Returns plaintext string. */
async function decryptFromCache(ciphertext: string, cacheKey: CryptoKey): Promise<string> {
  const decoder = new TextDecoder();
  const data = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
  if (data.length < 12) throw new Error('Cache ciphertext too short');
  const iv = data.slice(0, 12);
  const encrypted = data.slice(12);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    cacheKey,
    encrypted,
  );
  return decoder.decode(decrypted);
}

/** Get cache encryption key from current auth state. Returns null if unavailable. */
async function getCacheKey(): Promise<CryptoKey | null> {
  const derivedKey = useAuthStore.getState().derivedKey;
  if (!derivedKey) return null;
  return deriveCacheKey(derivedKey);
}

// ── IndexedDB operations ────────────────────────────────────────────────────

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('channelId', 'channelId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error(request.error?.message ?? 'Failed to open database'));
  });
}

export async function cacheMessage(
  id: string,
  channelId: string,
  plaintext: string,
): Promise<void> {
  const cacheKey = await getCacheKey();
  if (!cacheKey) return; // No key available — skip caching to avoid storing plaintext

  const ciphertext = await encryptForCache(plaintext, cacheKey);

  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const entry: CachedMessage = { id, channelId, ciphertext, cachedAt: Date.now() };
    store.put(entry);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(new Error(tx.error?.message ?? 'Failed to cache message'));
    };
  });
}

export async function getCachedMessage(id: string): Promise<string | null> {
  const cacheKey = await getCacheKey();
  if (!cacheKey) return null;

  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(id);
    req.onsuccess = async () => {
      const result = req.result as CachedMessage | undefined;
      if (!result?.ciphertext) { resolve(null); return; }
      try {
        resolve(await decryptFromCache(result.ciphertext, cacheKey));
      } catch {
        resolve(null); // Decrypt failed — key rotated or data corrupted
      }
    };
    req.onerror = () => reject(new Error(req.error?.message ?? 'Failed to get cached message'));
    tx.oncomplete = () => db.close();
  });
}

export async function getCachedMessages(ids: string[]): Promise<Map<string, string>> {
  const cacheKey = await getCacheKey();
  if (!cacheKey) return new Map();

  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const results = new Map<string, string>();
    let remaining = ids.length;
    if (remaining === 0) {
      db.close();
      resolve(results);
      return;
    }
    for (const id of ids) {
      const req = store.get(id);
      req.onsuccess = async () => {
        const result = req.result as CachedMessage | undefined;
        if (result?.ciphertext) {
          try {
            results.set(id, await decryptFromCache(result.ciphertext, cacheKey));
          } catch {
            // Decrypt failed — skip this entry
          }
        }
        remaining--;
        if (remaining === 0) resolve(results);
      };
      req.onerror = () => {
        remaining--;
        if (remaining === 0) resolve(results);
      };
    }
    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      db.close();
      reject(new Error(tx.error?.message ?? 'Failed to get cached messages'));
    };
  });
}

export async function deleteCachedMessage(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(id);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(new Error(tx.error?.message ?? 'Failed to delete cached message'));
    };
  });
}

export async function clearChannelCache(channelId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('channelId');
    const req = index.openCursor(IDBKeyRange.only(channelId));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    /* v8 ignore next 4 */
    tx.onerror = () => {
      db.close();
      reject(new Error(tx.error?.message ?? 'Failed to clear channel cache'));
    };
  });
}

export async function clearAllMessageCache(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    /* v8 ignore next 4 */
    tx.onerror = () => {
      db.close();
      reject(new Error(tx.error?.message ?? 'Failed to clear message cache'));
    };
  });
}
