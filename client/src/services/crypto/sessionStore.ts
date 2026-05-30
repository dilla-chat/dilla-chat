/**
 * sessionStore.ts — Encrypted persistence for group sessions in IndexedDB
 *
 * Stores serialized GroupSession objects encrypted with AES-GCM using a key
 * derived from the user's derivedKey (HKDF). Sessions survive page reloads
 * so messages can be decrypted without re-establishing the session.
 *
 * H-12: when CRYPTO_BACKEND='worker' (default), every call below
 * forwards to the Web Worker via `workerClient` so the AES-GCM KEK +
 * IndexedDB handle live in worker scope. The main-thread path is
 * preserved for tests (backend='main') and for environments without
 * a `Worker` global (SSR, hostile iframes).
 */

import { useAuthStore } from '../../stores/authStore';
import {
  getCryptoBackend,
  isSessionInitInWorker,
  sessionInitInWorker,
  sessionSaveInWorker,
  sessionLoadInWorker,
  sessionLoadAllInWorker,
  sessionDeleteInWorker,
} from './workerClient';

/** Lazy: ensure the worker has the KEK before the first IDB op. The
 *  derivedKey lives in the auth store; we only push it to the worker
 *  once. Subsequent ops short-circuit on `isSessionInitInWorker`. */
async function ensureWorkerInit(): Promise<boolean> {
  if (getCryptoBackend() !== 'worker') return false;
  if (typeof Worker === 'undefined') return false;
  if (isSessionInitInWorker()) return true;
  const derivedKey = useAuthStore.getState().derivedKey;
  if (!derivedKey) return false;
  await sessionInitInWorker(derivedKey);
  return true;
}

const DB_NAME = 'dilla-sessions';
const DB_VERSION = 1;
const STORE_NAME = 'group-sessions';

interface StoredSession {
  channelId: string;
  /** AES-GCM encrypted JSON (base64) */
  ciphertext: string;
  updatedAt: number;
}

// ── Encryption helpers (same pattern as messageCache.ts) ───────────────────

async function deriveSessionKey(derivedKey: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(derivedKey),
    'HKDF',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('dilla-session-store-v1'),
      info: encoder.encode('session-encryption'),
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptSession(json: string, key: CryptoKey): Promise<string> {
  const encoder = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(json),
  );
  const combined = new Uint8Array(12 + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), 12);
  return btoa(String.fromCharCode(...combined));
}

async function decryptSession(ciphertext: string, key: CryptoKey): Promise<string> {
  const decoder = new TextDecoder();
  const data = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
  if (data.length < 12) throw new Error('Session ciphertext too short');
  const iv = data.slice(0, 12);
  const encrypted = data.slice(12);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    encrypted,
  );
  return decoder.decode(decrypted);
}

async function getSessionKey(): Promise<CryptoKey | null> {
  const derivedKey = useAuthStore.getState().derivedKey;
  if (!derivedKey) return null;
  return deriveSessionKey(derivedKey);
}

// ── IndexedDB operations ───────────────────────────────────────────────────

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'channelId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error(request.error?.message ?? 'Failed to open session DB'));
  });
}

/** Save a group session (encrypted) to IndexedDB. */
export async function saveGroupSession(channelId: string, sessionJson: object): Promise<void> {
  if (await ensureWorkerInit()) {
    await sessionSaveInWorker(channelId, sessionJson);
    return;
  }
  const key = await getSessionKey();
  if (!key) return;

  const ciphertext = await encryptSession(JSON.stringify(sessionJson), key);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const entry: StoredSession = { channelId, ciphertext, updatedAt: Date.now() };
    store.put(entry);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(new Error(tx.error?.message ?? 'Failed to save session')); };
  });
}

/** Load a group session from IndexedDB and decrypt it. Returns null if not found or decryption fails. */
export async function loadGroupSession(channelId: string): Promise<Record<string, unknown> | null> {
  if (await ensureWorkerInit()) {
    return sessionLoadInWorker(channelId);
  }
  const key = await getSessionKey();
  if (!key) return null;

  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(channelId);
    req.onsuccess = async () => {
      const result = req.result as StoredSession | undefined;
      if (!result?.ciphertext) { resolve(null); return; }
      try {
        const json = await decryptSession(result.ciphertext, key);
        resolve(JSON.parse(json));
      } catch {
        resolve(null);
      }
    };
    req.onerror = () => reject(new Error(req.error?.message ?? 'Failed to load session'));
    tx.oncomplete = () => db.close();
  });
}

/** Load all stored group sessions. */
export async function loadAllGroupSessions(): Promise<Map<string, Record<string, unknown>>> {
  if (await ensureWorkerInit()) {
    return sessionLoadAllInWorker();
  }
  const key = await getSessionKey();
  if (!key) return new Map();

  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = async () => {
      const results = new Map<string, Record<string, unknown>>();
      for (const entry of req.result as StoredSession[]) {
        try {
          const json = await decryptSession(entry.ciphertext, key);
          results.set(entry.channelId, JSON.parse(json));
        } catch {
          // Skip corrupt/unreadable sessions
        }
      }
      resolve(results);
    };
    req.onerror = () => { db.close(); reject(new Error(req.error?.message ?? 'Failed to load sessions')); };
    tx.oncomplete = () => db.close();
  });
}

/** Delete a stored group session. */
export async function deleteGroupSession(channelId: string): Promise<void> {
  if (await ensureWorkerInit()) {
    await sessionDeleteInWorker(channelId);
    return;
  }
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(channelId);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(new Error(tx.error?.message ?? 'Failed to delete session')); };
  });
}
