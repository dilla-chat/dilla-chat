/**
 * keyStore.ts — Identity key management with IndexedDB persistence
 *
 * Ported from src-tauri/src/keystore.rs. Supports V3 (MEK) key format.
 * Uses IndexedDB for storage in browsers, with a compatible API for Tauri.
 *
 * Key format: V3 MEK (Master Encryption Key) with multiple key slots,
 * identical to the Rust implementation's EncryptedKeyFileV3.
 */

import {
  aesGcmEncrypt,
  aesGcmDecrypt,
  hkdfDerive,
  randomBytes,
  generateEd25519KeyPair,
  exportEd25519PrivateKey,
  importEd25519PrivateKey,
  ed25519Sign,
  generateX25519KeyPair,
  exportX25519PrivateKey,
  fromBase64,
  encoder,
  type X25519KeyPair,
} from './cryptoCore';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PasskeyCredential {
  id: string;
  name: string;
  created_at: string;
}

export interface KeySlot {
  server_url: string;
  prf_salt: number[];
  credentials: PasskeyCredential[];
  wrapped_nonce: number[];
  wrapped_mek: number[];
}

interface RecoverySlot {
  wrapped_nonce: number[];
  wrapped_mek: number[];
  recovery_key_hash: number[];
}

export interface PasswordSlot {
  server_url: string;
  credentials: PasskeyCredential[];
  pbkdf2_salt: number[]; // 16 bytes random
  pbkdf2_iterations: number; // 600_000
  wrapped_nonce: number[];
  wrapped_mek: number[];
  passphrase_hash: number[]; // SHA-256 of derived key (for early rejection)
}

interface EncryptedKeyFileV3 {
  version: 3;
  mek_nonce: number[];
  mek_ciphertext: number[];
  public_key: number[];
  key_slots: KeySlot[];
  recovery_slot: RecoverySlot | null;
  password_slots?: PasswordSlot[];
}

// ─── Key derivation helpers ──────────────────────────────────────────────────

/** Derive AES key from WebAuthn PRF output */
async function deriveAesFromPrf(prfOutput: Uint8Array): Promise<Uint8Array> {
  return hkdfDerive(
    prfOutput,
    encoder.encode('DillaKeyEncryption'),
    32,
    encoder.encode('dilla-prf-aes-v1'),
  );
}

/** Derive AES key from recovery key */
async function deriveAesFromRecovery(recoveryKey: Uint8Array): Promise<Uint8Array> {
  return hkdfDerive(
    recoveryKey,
    encoder.encode('DillaRecoveryKey'),
    32,
    encoder.encode('dilla-recovery-aes-v1'),
  );
}

/** SHA-256 hash */
async function sha256Hash(data: Uint8Array): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest('SHA-256', data as unknown as BufferSource);
  return new Uint8Array(hash);
}

/** Wrap MEK with a passkey PRF key */
async function wrapMekWithPrf(
  mek: Uint8Array,
  derivedKey: Uint8Array,
  serverUrl: string,
  prfSalt: Uint8Array,
  credentials: PasskeyCredential[],
): Promise<KeySlot> {
  const aesKey = await deriveAesFromPrf(derivedKey);
  const wrapped = await aesGcmEncrypt(aesKey, mek);
  // wrapped = nonce(12) + ciphertext
  return {
    server_url: serverUrl,
    prf_salt: Array.from(prfSalt),
    credentials,
    wrapped_nonce: Array.from(wrapped.slice(0, 12)),
    wrapped_mek: Array.from(wrapped.slice(12)),
  };
}

/** Unwrap MEK by trying each key slot */
async function unwrapMekWithPrf(
  slots: KeySlot[],
  derivedKey: Uint8Array,
): Promise<Uint8Array> {
  const aesKey = await deriveAesFromPrf(derivedKey);
  for (const slot of slots) {
    try {
      const data = new Uint8Array([...slot.wrapped_nonce, ...slot.wrapped_mek]);
      return await aesGcmDecrypt(aesKey, data);
    } catch {
      continue; // Try next slot
    }
  }
  throw new Error('No matching key slot found — wrong passkey or key file corrupted');
}

/** Wrap MEK with recovery key */
async function wrapMekWithRecovery(
  mek: Uint8Array,
  recoveryKey: Uint8Array,
): Promise<RecoverySlot> {
  const aesKey = await deriveAesFromRecovery(recoveryKey);
  const wrapped = await aesGcmEncrypt(aesKey, mek);
  const keyHash = await sha256Hash(recoveryKey);
  return {
    wrapped_nonce: Array.from(wrapped.slice(0, 12)),
    wrapped_mek: Array.from(wrapped.slice(12)),
    recovery_key_hash: Array.from(keyHash),
  };
}

/** Unwrap MEK with recovery key */
async function unwrapMekWithRecovery(
  slot: RecoverySlot,
  recoveryKey: Uint8Array,
): Promise<Uint8Array> {
  const actualHash = await sha256Hash(recoveryKey);
  const expectedHash = new Uint8Array(slot.recovery_key_hash);
  let diff = actualHash.length ^ expectedHash.length;
  for (let i = 0; i < Math.max(actualHash.length, expectedHash.length); i++) {
    diff |= (actualHash[i] ?? 0) ^ (expectedHash[i] ?? 0);
  }
  if (diff !== 0) throw new Error('Invalid recovery key');
  const aesKey = await deriveAesFromRecovery(recoveryKey);
  const data = new Uint8Array([...slot.wrapped_nonce, ...slot.wrapped_mek]);
  return aesGcmDecrypt(aesKey, data);
}

// ─── Passphrase (PBKDF2) helpers ──────────────────────────────────────────────

const PBKDF2_ITERATIONS = 600_000;

/** Derive AES-256 key from a passphrase using PBKDF2-SHA256 */
async function deriveAesFromPassphrase(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as unknown as BufferSource, iterations },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

/** Wrap MEK with a passphrase-derived key */
async function wrapMekWithPassphrase(
  mek: Uint8Array,
  passphrase: string,
  serverUrl: string,
  credentials: PasskeyCredential[],
): Promise<PasswordSlot> {
  const salt = randomBytes(16);
  const derivedKey = await deriveAesFromPassphrase(passphrase, salt, PBKDF2_ITERATIONS);
  const wrapped = await aesGcmEncrypt(derivedKey, mek);
  const keyHash = await sha256Hash(derivedKey);
  return {
    server_url: serverUrl,
    credentials,
    pbkdf2_salt: Array.from(salt),
    pbkdf2_iterations: PBKDF2_ITERATIONS,
    wrapped_nonce: Array.from(wrapped.slice(0, 12)),
    wrapped_mek: Array.from(wrapped.slice(12)),
    passphrase_hash: Array.from(keyHash),
  };
}

/** Unwrap MEK by trying each password slot */
async function unwrapMekWithPassphrase(
  slots: PasswordSlot[],
  passphrase: string,
): Promise<Uint8Array> {
  for (const slot of slots) {
    const salt = new Uint8Array(slot.pbkdf2_salt);
    const derivedKey = await deriveAesFromPassphrase(passphrase, salt, slot.pbkdf2_iterations);
    // Early rejection via hash comparison
    const keyHash = await sha256Hash(derivedKey);
    const expected = new Uint8Array(slot.passphrase_hash);
    if (keyHash.length !== expected.length || !keyHash.every((v, i) => v === expected[i])) {
      continue;
    }
    try {
      const data = new Uint8Array([...slot.wrapped_nonce, ...slot.wrapped_mek]);
      return await aesGcmDecrypt(derivedKey, data);
    } catch {
      /* v8 ignore next */
      continue;
    }
  }
  throw new Error('Wrong passphrase or no matching password slot found');
}

// ─── IndexedDB Storage ────────────────────────────────────────────────────────

const DB_NAME = 'dilla-keystore';
const DB_VERSION = 1;
const STORE_NAME = 'keys';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error(request.error?.message ?? 'Failed to open key database'));
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(new Error(req.error?.message ?? 'Failed to read from key store'));
    tx.oncomplete = () => db.close();
  });
}

async function idbPut(key: string, value: unknown): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(value, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(new Error(tx.error?.message ?? 'Failed to write to key store')); };
  });
}

async function idbDelete(key: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(new Error(tx.error?.message ?? 'Failed to delete from key store')); };
  });
}

// ─── Identity Store ───────────────────────────────────────────────────────────

export interface IdentityKeys {
  signingKey: CryptoKey;          // Ed25519 private key
  signingPublicKey: CryptoKey;    // Ed25519 public key
  publicKeyBytes: Uint8Array;     // Raw Ed25519 public key
  dhKeyPair: X25519KeyPair;       // X25519 identity DH keypair
}

/** Shared identity generation: keypairs, recovery key, MEK encryption */
async function generateAndEncryptIdentity(): Promise<{
  ed25519: { privateKey: CryptoKey; publicKey: CryptoKey; publicKeyBytes: Uint8Array };
  dhKeyPair: X25519KeyPair;
  recoveryKey: Uint8Array;
  encrypted: Uint8Array;
  mek: Uint8Array;
}> {
  const ed25519 = await generateEd25519KeyPair();
  const dhKeyPair = await generateX25519KeyPair();
  const recoveryKey = randomBytes(32);

  const signingKeyPkcs8 = await exportEd25519PrivateKey(ed25519.privateKey);
  const dhPrivatePkcs8 = await exportX25519PrivateKey(dhKeyPair.privateKey);

  const payload = JSON.stringify({
    signing_key_pkcs8: Array.from(signingKeyPkcs8),
    dh_private_pkcs8: Array.from(dhPrivatePkcs8),
    dh_public_key: Array.from(dhKeyPair.publicKeyBytes),
    public_key: Array.from(ed25519.publicKeyBytes),
  });

  const mek = randomBytes(32);
  const encrypted = await aesGcmEncrypt(mek, encoder.encode(payload));

  return { ed25519, dhKeyPair, recoveryKey, encrypted, mek };
}

/** Build the final result returned by both createIdentity variants */
function buildIdentityResult(
  ed25519: { privateKey: CryptoKey; publicKey: CryptoKey; publicKeyBytes: Uint8Array },
  dhKeyPair: X25519KeyPair,
  recoveryKey: Uint8Array,
): { publicKeyB64: string; publicKeyHex: string; recoveryKey: Uint8Array; identity: IdentityKeys } {
  const publicKeyHex = Array.from(ed25519.publicKeyBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const publicKeyB64 = btoa(String.fromCodePoint(...ed25519.publicKeyBytes));

  return {
    publicKeyB64,
    publicKeyHex,
    recoveryKey,
    identity: {
      signingKey: ed25519.privateKey,
      signingPublicKey: ed25519.publicKey,
      publicKeyBytes: ed25519.publicKeyBytes,
      dhKeyPair,
    },
  };
}

/**
 * Generate a new identity, encrypt and store it.
 * Returns the public key hex and a recovery key.
 */
export async function createIdentity(
  serverUrl: string,
  prfDerivedKey: Uint8Array,
  prfSalt: Uint8Array,
  credentials: PasskeyCredential[],
): Promise<{ publicKeyB64: string; publicKeyHex: string; recoveryKey: Uint8Array; identity: IdentityKeys }> {
  const { ed25519, dhKeyPair, recoveryKey, encrypted, mek } = await generateAndEncryptIdentity();

  // Wrap MEK with passkey PRF
  const keySlot = await wrapMekWithPrf(mek, prfDerivedKey, serverUrl, prfSalt, credentials);
  const recoverySlot = await wrapMekWithRecovery(mek, recoveryKey);

  const keyFile: EncryptedKeyFileV3 = {
    version: 3,
    mek_nonce: Array.from(encrypted.slice(0, 12)),
    mek_ciphertext: Array.from(encrypted.slice(12)),
    public_key: Array.from(ed25519.publicKeyBytes),
    key_slots: [keySlot],
    recovery_slot: recoverySlot,
  };

  await idbPut('identity.key', keyFile);

  return buildIdentityResult(ed25519, dhKeyPair, recoveryKey);
}

/**
 * Unlock identity using passkey PRF-derived key.
 */
export async function unlockWithPrf(prfDerivedKey: Uint8Array): Promise<IdentityKeys> {
  const keyFile = await idbGet<EncryptedKeyFileV3>('identity.key');
  if (!keyFile) throw new Error('No identity found — please create one first');

  const mek = await unwrapMekWithPrf(keyFile.key_slots, prfDerivedKey);
  return decryptIdentity(keyFile, mek);
}

/**
 * Unlock identity using recovery key.
 */
export async function unlockWithRecovery(recoveryKey: Uint8Array): Promise<IdentityKeys> {
  const keyFile = await idbGet<EncryptedKeyFileV3>('identity.key');
  if (!keyFile) throw new Error('No identity found — please create one first');
  if (!keyFile.recovery_slot) throw new Error('No recovery slot in key file');

  const mek = await unwrapMekWithRecovery(keyFile.recovery_slot, recoveryKey);
  return decryptIdentity(keyFile, mek);
}

/**
 * Generate a new identity encrypted with a passphrase (for non-PRF authenticators).
 * The passkey still authenticates; the passphrase provides key material.
 */
export async function createIdentityWithPassphrase(
  serverUrl: string,
  passphrase: string,
  credentials: PasskeyCredential[],
): Promise<{ publicKeyB64: string; publicKeyHex: string; recoveryKey: Uint8Array; identity: IdentityKeys }> {
  const { ed25519, dhKeyPair, recoveryKey, encrypted, mek } = await generateAndEncryptIdentity();

  // Wrap MEK with passphrase instead of PRF
  const passwordSlot = await wrapMekWithPassphrase(mek, passphrase, serverUrl, credentials);
  const recoverySlot = await wrapMekWithRecovery(mek, recoveryKey);

  const keyFile: EncryptedKeyFileV3 = {
    version: 3,
    mek_nonce: Array.from(encrypted.slice(0, 12)),
    mek_ciphertext: Array.from(encrypted.slice(12)),
    public_key: Array.from(ed25519.publicKeyBytes),
    key_slots: [],
    recovery_slot: recoverySlot,
    password_slots: [passwordSlot],
  };

  await idbPut('identity.key', keyFile);

  return buildIdentityResult(ed25519, dhKeyPair, recoveryKey);
}

/**
 * Unlock identity using a passphrase (for non-PRF password slots).
 */
export async function unlockWithPassphrase(passphrase: string): Promise<IdentityKeys> {
  const keyFile = await idbGet<EncryptedKeyFileV3>('identity.key');
  if (!keyFile) throw new Error('No identity found — please create one first');

  const slots = keyFile.password_slots ?? [];
  if (slots.length === 0) throw new Error('No password slots in key file');

  const mek = await unwrapMekWithPassphrase(slots, passphrase);
  return decryptIdentity(keyFile, mek);
}

async function decryptIdentity(keyFile: EncryptedKeyFileV3, mek: Uint8Array): Promise<IdentityKeys> {
  const data = new Uint8Array([...keyFile.mek_nonce, ...keyFile.mek_ciphertext]);
  const decrypted = await aesGcmDecrypt(mek, data);
  const payload = JSON.parse(new TextDecoder().decode(decrypted));

  const signingKey = await importEd25519PrivateKey(new Uint8Array(payload.signing_key_pkcs8));
  const jwk = await crypto.subtle.exportKey('jwk', signingKey);
  const publicKeyBytes = fromBase64url(jwk.x!);
  const signingPublicKey = await crypto.subtle.importKey(
    'raw', publicKeyBytes.buffer as ArrayBuffer, 'Ed25519', true, ['verify'],
  );

  // Import DH keypair
  const { importX25519PrivateKey } = await import('./cryptoCore');
  const dhPrivKey = await importX25519PrivateKey(new Uint8Array(payload.dh_private_pkcs8));
  const dhPubBytes = new Uint8Array(payload.dh_public_key);

  return {
    signingKey,
    signingPublicKey,
    publicKeyBytes,
    dhKeyPair: {
      privateKey: dhPrivKey,
      publicKey: await crypto.subtle.importKey('raw', dhPubBytes.buffer as ArrayBuffer, 'X25519', true, []),
      publicKeyBytes: dhPubBytes,
    },
  };
}

function fromBase64url(b64url: string): Uint8Array {
  const b64 = b64url.replaceAll('-', '+').replaceAll('_', '/');
  const pad = b64.length % 4;
  return fromBase64(pad ? b64 + '='.repeat(4 - pad) : b64);
}

/**
 * Add a new server key slot to the existing identity.
 */
export async function addKeySlot(
  existingPrfKey: Uint8Array,
  newServerUrl: string,
  newPrfKey: Uint8Array,
  newPrfSalt: Uint8Array,
  newCredentials: PasskeyCredential[],
): Promise<void> {
  const keyFile = await idbGet<EncryptedKeyFileV3>('identity.key');
  if (!keyFile) throw new Error('No identity found');

  const mek = await unwrapMekWithPrf(keyFile.key_slots, existingPrfKey);
  const newSlot = await wrapMekWithPrf(mek, newPrfKey, newServerUrl, newPrfSalt, newCredentials);
  keyFile.key_slots.push(newSlot);

  await idbPut('identity.key', keyFile);
}

/**
 * Get credential info from the stored identity.
 */
export async function getCredentialInfo(): Promise<{
  credentials: PasskeyCredential[];
  prfSalt: Uint8Array;
  keySlots: KeySlot[];
  passwordSlots: PasswordSlot[];
  hasPasswordSlots: boolean;
} | null> {
  const keyFile = await idbGet<EncryptedKeyFileV3>('identity.key');
  if (!keyFile) return null;

  const allCreds: PasskeyCredential[] = [];
  let prfSalt = new Uint8Array(0);
  for (const slot of keyFile.key_slots) {
    allCreds.push(...slot.credentials);
    if (prfSalt.length === 0) {
      prfSalt = new Uint8Array(slot.prf_salt);
    }
  }

  const passwordSlots = keyFile.password_slots ?? [];
  for (const slot of passwordSlots) {
    allCreds.push(...slot.credentials);
  }

  return {
    credentials: allCreds,
    prfSalt,
    keySlots: keyFile.key_slots,
    passwordSlots,
    hasPasswordSlots: passwordSlots.length > 0,
  };
}

/**
 * Check if an identity exists.
 */
export async function hasIdentity(): Promise<boolean> {
  const keyFile = await idbGet<EncryptedKeyFileV3>('identity.key');
  return keyFile != null;
}

/**
 * Get the public key from stored identity (without unlocking).
 */
export async function getPublicKey(): Promise<Uint8Array | null> {
  const keyFile = await idbGet<EncryptedKeyFileV3>('identity.key');
  if (!keyFile) return null;
  return new Uint8Array(keyFile.public_key);
}

/**
 * Export identity as an encrypted blob for server-side escrow.
 * The blob is encrypted with the recovery key.
 */
export async function exportIdentityBlob(): Promise<string | null> {
  const keyFile = await idbGet<EncryptedKeyFileV3>('identity.key');
  if (!keyFile) return null;
  return JSON.stringify(keyFile);
}

/**
 * Import identity from a server-escrowed blob.
 */
export async function importIdentityBlob(blob: string): Promise<void> {
  const keyFile: EncryptedKeyFileV3 = JSON.parse(blob);
  if (keyFile.version !== 3) throw new Error(`Unsupported key file version: ${keyFile.version}`);
  await idbPut('identity.key', keyFile);
}

/**
 * Delete the stored identity (destructive!).
 * Also clears the local message plaintext cache.
 */
export async function deleteIdentity(): Promise<void> {
  await idbDelete('identity.key');
  const { clearAllMessageCache } = await import('./messageCache');
  await clearAllMessageCache();
}

// ─── Session Storage ──────────────────────────────────────────────────────────

/**
 * Save encrypted crypto sessions to IndexedDB.
 */
export async function saveSessions(data: object, passphrase: string): Promise<void> {
  const { encryptSessionData } = await import('./cryptoCore');
  const encrypted = await encryptSessionData(data, passphrase);
  await idbPut('sessions.dat', Array.from(encrypted));
}

/**
 * Load and decrypt crypto sessions from IndexedDB.
 */
export async function loadSessions(passphrase: string): Promise<object | null> {
  const stored = await idbGet<number[]>('sessions.dat');
  if (!stored) return null;
  const { decryptSessionData } = await import('./cryptoCore');
  return decryptSessionData(new Uint8Array(stored), passphrase);
}

// ─── Recovery Key Encoding ────────────────────────────────────────────────────

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Encode a 32-byte recovery key as human-readable Crockford base32 with dashes */
export function encodeRecoveryKey(key: Uint8Array): string {
  let bits = '';
  for (const byte of key) {
    bits += byte.toString(2).padStart(8, '0');
  }
  let encoded = '';
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, '0');
    encoded += CROCKFORD_ALPHABET[Number.parseInt(chunk, 2)];
  }
  // Group into 4-char blocks with dashes
  return encoded.match(/.{1,4}/g)?.join('-') ?? encoded;
}

/** Decode a Crockford base32 recovery key back to bytes */
export function decodeRecoveryKey(encoded: string): Uint8Array {
  const clean = encoded.replaceAll('-', '').replaceAll(/\s/g, '').toUpperCase()
    .replaceAll('O', '0').replaceAll('I', '1').replaceAll('L', '1');
  let bits = '';
  for (const char of clean) {
    const idx = CROCKFORD_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error(`Invalid character in recovery key: ${char}`);
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  }
  return bytes;
}

/** Generate a random PRF salt */
export function generatePrfSalt(): Uint8Array {
  return randomBytes(32);
}

/** Generate a random recovery key */
export function generateRecoveryKey(): Uint8Array {
  return randomBytes(32);
}

/** Sign a challenge (for auth) */
export async function signChallenge(
  signingKey: CryptoKey,
  challenge: Uint8Array,
): Promise<Uint8Array> {
  return ed25519Sign(signingKey, challenge);
}
