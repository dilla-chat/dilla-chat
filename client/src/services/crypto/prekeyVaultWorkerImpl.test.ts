// Coverage for the H-12d.2 prekey vault. Same shape as the session
// stores — KEK installed via initSessionKey, secrets persisted AES-GCM
// in IndexedDB, decrypted on read.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initSessionKey, resetSessionKey } from './sessionStoreWorkerImpl';
import {
  savePrekeySecrets,
  getPrekeySecrets,
  clearPrekeyVault,
  resetPrekeyVault,
} from './prekeyVaultWorkerImpl';

async function wipeIDB() {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('dilla-sessions');
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

function b64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

describe('prekeyVaultWorkerImpl', () => {
  beforeEach(async () => {
    resetSessionKey();
    resetPrekeyVault();
    await wipeIDB();
  });

  afterEach(() => {
    resetSessionKey();
    resetPrekeyVault();
  });

  it('save then get roundtrips signed_prekey + one-time prekeys', async () => {
    await initSessionKey('vault-kek');
    const signed = b64([1, 2, 3, 4]);
    const otpks = [b64([5, 6, 7, 8]), b64([9, 10, 11, 12])];
    await savePrekeySecrets(signed, otpks);
    const got = await getPrekeySecrets();
    expect(got).not.toBeNull();
    expect(Array.from(got!.signed_prekey_private)).toEqual([1, 2, 3, 4]);
    expect(got!.one_time_prekey_privates.length).toBe(2);
    expect(Array.from(got!.one_time_prekey_privates[0])).toEqual([5, 6, 7, 8]);
    expect(Array.from(got!.one_time_prekey_privates[1])).toEqual([9, 10, 11, 12]);
  });

  it('savePrekeySecrets throws when no KEK is installed', async () => {
    await expect(savePrekeySecrets(b64([1, 2]), [])).rejects.toThrow(
      /KEK not set/i,
    );
  });

  it('getPrekeySecrets returns null when no vault has been saved', async () => {
    await initSessionKey('vault-kek');
    expect(await getPrekeySecrets()).toBeNull();
  });

  it('getPrekeySecrets returns null when no KEK installed (cold start)', async () => {
    // Save with one KEK then reset everything (simulating worker restart
    // before init).
    await initSessionKey('vault-kek');
    await savePrekeySecrets(b64([1, 2]), [b64([3, 4])]);
    resetSessionKey();
    resetPrekeyVault();
    expect(await getPrekeySecrets()).toBeNull();
  });

  it('getPrekeySecrets uses the in-memory cache on subsequent calls', async () => {
    await initSessionKey('vault-kek');
    await savePrekeySecrets(b64([7, 8, 9]), []);
    const first = await getPrekeySecrets();
    // Wipe IDB out from under us — the second call should still hit
    // the cache and return data.
    await wipeIDB();
    const second = await getPrekeySecrets();
    expect(second).not.toBeNull();
    expect(Array.from(second!.signed_prekey_private)).toEqual(
      Array.from(first!.signed_prekey_private),
    );
  });

  it('clearPrekeyVault wipes the persisted entry', async () => {
    await initSessionKey('vault-kek');
    await savePrekeySecrets(b64([1, 2]), [b64([3, 4])]);
    await clearPrekeyVault();
    // After clear, getPrekeySecrets returns null even though the KEK
    // is still installed (cached secrets also cleared).
    expect(await getPrekeySecrets()).toBeNull();
  });

  it('getPrekeySecrets returns null when KEK is not installed and cache is empty', async () => {
    expect(await getPrekeySecrets()).toBeNull();
  });

  it('savePrekeySecrets throws when KEK is not installed', async () => {
    await expect(savePrekeySecrets(b64([1]), [])).rejects.toThrow(/KEK not set/);
  });

  it('rotating the KEK invalidates the existing vault (load returns null)', async () => {
    await initSessionKey('kek-a');
    await savePrekeySecrets(b64([1, 2]), [b64([3, 4])]);
    resetSessionKey();
    resetPrekeyVault();
    await initSessionKey('kek-b');
    expect(await getPrekeySecrets()).toBeNull();
  });
});
