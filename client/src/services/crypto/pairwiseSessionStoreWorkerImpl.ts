// H-12c.1: worker-scope encrypted IndexedDB store for pairwise
// (1:1 Double Ratchet) sessions. Mirrors the group-session store from
// H-12a (sessionStoreWorkerImpl.ts) but with a separate IDB store +
// key (peerId).
//
// Each row holds:
//   peerId      — the peer's stable user id (string)
//   ciphertext  — AES-GCM(JSON(session.toJSON()), KEK)
//                 KEK is the same one shared with the group store
//                 (derived from auth.derivedKey via HKDF).
//   updatedAt   — JS Date.now()
//
// The KEK lives in `sessionStoreWorkerImpl::initSessionKey` — we
// reuse it here so the worker only needs one init handshake.

import { initSessionKey as _markInitForCompat } from './sessionStoreWorkerImpl';
// The marker import keeps `initSessionKey` reachable through this
// module's import graph for circular-dep safety; the actual init
// runs in sessionStoreWorkerImpl.
void _markInitForCompat;

const DB_NAME = 'dilla-sessions';
const DB_VERSION = 2;
const PAIRWISE_STORE = 'pairwise-sessions';

let cachedKey: CryptoKey | null = null;

/** H-12c.1: called from the H-12a init path so both stores share the
 *  same KEK. Internal; pairwiseSession ops resolve the cached key
 *  via `getOrPromptKey` below. */
export function setPairwiseSessionKey(key: CryptoKey): void {
  cachedKey = key;
}

export function resetPairwiseSessionKey(): void {
  cachedKey = null;
}

function getKey(): CryptoKey | null {
  return cachedKey;
}

async function encrypt(json: string, key: CryptoKey): Promise<string> {
  const enc = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(json));
  const combined = new Uint8Array(12 + ct.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ct), 12);
  return btoa(String.fromCharCode(...combined));
}

async function decrypt(ciphertext: string, key: CryptoKey): Promise<string> {
  const dec = new TextDecoder();
  const data = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
  if (data.length < 12) throw new Error('Pairwise ciphertext too short');
  const iv = data.slice(0, 12);
  const enc = data.slice(12);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, enc);
  return dec.decode(pt);
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('group-sessions')) {
        db.createObjectStore('group-sessions', { keyPath: 'channelId' });
      }
      if (!db.objectStoreNames.contains(PAIRWISE_STORE)) {
        db.createObjectStore(PAIRWISE_STORE, { keyPath: 'peerId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new Error(request.error?.message ?? 'Failed to open session DB'));
  });
}

interface StoredPairwiseSession {
  peerId: string;
  ciphertext: string;
  updatedAt: number;
}

export async function savePairwiseSession(
  peerId: string,
  sessionJson: object,
): Promise<void> {
  const key = getKey();
  if (!key) return;
  const ciphertext = await encrypt(JSON.stringify(sessionJson), key);
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PAIRWISE_STORE, 'readwrite');
    const store = tx.objectStore(PAIRWISE_STORE);
    const entry: StoredPairwiseSession = { peerId, ciphertext, updatedAt: Date.now() };
    store.put(entry);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(new Error(tx.error?.message ?? 'Failed to save pairwise session'));
    };
  });
}

export async function loadPairwiseSession(
  peerId: string,
): Promise<Record<string, unknown> | null> {
  const key = getKey();
  if (!key) return null;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PAIRWISE_STORE, 'readonly');
    const store = tx.objectStore(PAIRWISE_STORE);
    const req = store.get(peerId);
    req.onsuccess = async () => {
      const result = req.result as StoredPairwiseSession | undefined;
      if (!result?.ciphertext) {
        resolve(null);
        return;
      }
      try {
        const json = await decrypt(result.ciphertext, key);
        resolve(JSON.parse(json));
      } catch {
        resolve(null);
      }
    };
    req.onerror = () =>
      reject(new Error(req.error?.message ?? 'Failed to load pairwise session'));
    tx.oncomplete = () => db.close();
  });
}

export async function loadAllPairwiseSessions(): Promise<
  Array<[string, Record<string, unknown>]>
> {
  const key = getKey();
  if (!key) return [];
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PAIRWISE_STORE, 'readonly');
    const store = tx.objectStore(PAIRWISE_STORE);
    const req = store.getAll();
    req.onsuccess = async () => {
      const out: Array<[string, Record<string, unknown>]> = [];
      for (const entry of req.result as StoredPairwiseSession[]) {
        try {
          const json = await decrypt(entry.ciphertext, key);
          out.push([entry.peerId, JSON.parse(json)]);
        } catch {
          // skip corrupt rows
        }
      }
      resolve(out);
    };
    req.onerror = () => {
      db.close();
      reject(new Error(req.error?.message ?? 'Failed to load pairwise sessions'));
    };
    tx.oncomplete = () => db.close();
  });
}

export async function deletePairwiseSession(peerId: string): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PAIRWISE_STORE, 'readwrite');
    const store = tx.objectStore(PAIRWISE_STORE);
    store.delete(peerId);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(new Error(tx.error?.message ?? 'Failed to delete pairwise session'));
    };
  });
}
