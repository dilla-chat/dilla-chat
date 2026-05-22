// H-12d.2: worker-scope encrypted IndexedDB store for the user's
// prekey private keys. The bundle's PUBLIC half flows through the
// normal upload-to-server path; the SECRET half (signed prekey
// private + one-time prekey privates) is shipped to the worker once
// at boot/registration and never returns to the main heap.
//
// Schema:
//   DB     = "dilla-sessions" (shared with the session stores; v3
//            adds this new object store)
//   store  = "prekey-vault" — single row keyed by id=1
//   value  = { id: 1, ciphertext, updatedAt }
//
// Re-uses the H-12a KEK seeded via sessionStoreWorkerImpl::initSessionKey.
// Caller is responsible for fixing up DB_VERSION upgrade ordering.

import { savePairwiseSession as _ensurePairwiseModuleLoaded } from './pairwiseSessionStoreWorkerImpl';
// Keep the cross-module import live so DB upgrade ordering covers
// both stores when init runs. The reference is otherwise unused.
void _ensurePairwiseModuleLoaded;

const DB_NAME = 'dilla-sessions';
const DB_VERSION = 3;
const VAULT_STORE = 'prekey-vault';

let cachedKey: CryptoKey | null = null;
let cachedSecrets: PrekeySecretsBytes | null = null;

/** Serialized form. Uint8Array → number[] for JSON portability. */
interface PrekeySecretsBytes {
  signed_prekey_private: number[];
  one_time_prekey_privates: number[][];
}

export function setPrekeyVaultKey(key: CryptoKey): void {
  cachedKey = key;
}

export function resetPrekeyVault(): void {
  cachedKey = null;
  cachedSecrets = null;
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
  if (data.length < 12) throw new Error('Prekey vault ciphertext too short');
  const iv = data.slice(0, 12);
  const enc = data.slice(12);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, enc);
  return dec.decode(pt);
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('group-sessions')) {
        db.createObjectStore('group-sessions', { keyPath: 'channelId' });
      }
      if (!db.objectStoreNames.contains('pairwise-sessions')) {
        db.createObjectStore('pairwise-sessions', { keyPath: 'peerId' });
      }
      if (!db.objectStoreNames.contains(VAULT_STORE)) {
        db.createObjectStore(VAULT_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(new Error(req.error?.message ?? 'Failed to open prekey vault DB'));
  });
}

interface StoredVault {
  id: 1;
  ciphertext: string;
  updatedAt: number;
}

/** Persist the prekey secrets in the worker-side vault. Caller (main
 *  thread) ships them once after `generatePrekeyBundle` and then
 *  drops its in-memory copy. */
export async function savePrekeySecrets(
  signedPrekeyPrivateB64: string,
  oneTimePrekeyPrivatesB64: string[],
): Promise<void> {
  if (!cachedKey) {
    throw new Error('prekey vault: KEK not set; session.init must run first');
  }
  const signed = Array.from(b64ToBytes(signedPrekeyPrivateB64));
  const otpks = oneTimePrekeyPrivatesB64.map((b) => Array.from(b64ToBytes(b)));
  const secrets: PrekeySecretsBytes = {
    signed_prekey_private: signed,
    one_time_prekey_privates: otpks,
  };
  cachedSecrets = secrets;
  const ciphertext = await encrypt(JSON.stringify(secrets), cachedKey);
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(VAULT_STORE, 'readwrite');
    tx.objectStore(VAULT_STORE).put({ id: 1, ciphertext, updatedAt: Date.now() } as StoredVault);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(new Error(tx.error?.message ?? 'Failed to save prekey vault'));
    };
  });
}

/** Return the cached secrets in WIRE form (Uint8Arrays), loading
 *  from IDB on first call. Returns null when the vault is empty. */
export async function getPrekeySecrets(): Promise<{
  signed_prekey_private: Uint8Array;
  one_time_prekey_privates: Uint8Array[];
} | null> {
  if (cachedSecrets) {
    return {
      signed_prekey_private: new Uint8Array(cachedSecrets.signed_prekey_private),
      one_time_prekey_privates: cachedSecrets.one_time_prekey_privates.map(
        (b) => new Uint8Array(b),
      ),
    };
  }
  if (!cachedKey) return null;
  const db = await openDB();
  const raw = await new Promise<StoredVault | null>((resolve, reject) => {
    const tx = db.transaction(VAULT_STORE, 'readonly');
    const req = tx.objectStore(VAULT_STORE).get(1);
    req.onsuccess = () => resolve((req.result as StoredVault) ?? null);
    req.onerror = () => reject(new Error(req.error?.message ?? 'Failed to load vault'));
    tx.oncomplete = () => db.close();
  });
  if (!raw?.ciphertext) return null;
  try {
    const json = await decrypt(raw.ciphertext, cachedKey);
    const parsed = JSON.parse(json) as PrekeySecretsBytes;
    cachedSecrets = parsed;
    return {
      signed_prekey_private: new Uint8Array(parsed.signed_prekey_private),
      one_time_prekey_privates: parsed.one_time_prekey_privates.map(
        (b) => new Uint8Array(b),
      ),
    };
  } catch {
    return null;
  }
}

export async function clearPrekeyVault(): Promise<void> {
  cachedSecrets = null;
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(VAULT_STORE, 'readwrite');
    tx.objectStore(VAULT_STORE).clear();
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(new Error(tx.error?.message ?? 'Failed to clear prekey vault'));
    };
  });
}

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
