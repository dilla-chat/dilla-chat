// Coverage for the H-12 worker-scope group-session store.
//
// Roundtrip-tests the saveSession / loadSession / loadAllSessions /
// deleteSession surface against fake-indexeddb. The encryption uses
// real WebCrypto AES-GCM (node 22 webcrypto API), so the ciphertext
// in IDB is genuinely AEAD-sealed — flipping the cached KEK after
// init also tears down the ability to read back.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  initSessionKey,
  resetSessionKey,
  saveSession,
  loadSession,
  loadAllSessions,
  deleteSession,
} from './sessionStoreWorkerImpl';

async function wipeIDB() {
  // fake-indexeddb keeps state across tests; delete the DB so each
  // spec starts fresh.
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('dilla-sessions');
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

describe('sessionStoreWorkerImpl', () => {
  beforeEach(async () => {
    resetSessionKey();
    await wipeIDB();
  });

  afterEach(async () => {
    resetSessionKey();
  });

  it('save+load roundtrips a session under the same KEK', async () => {
    await initSessionKey('passphrase-derived-key');
    await saveSession('ch-1', { state: 1, msgs: [{ id: 'm1' }] });
    const loaded = await loadSession('ch-1');
    expect(loaded).toEqual({ state: 1, msgs: [{ id: 'm1' }] });
  });

  it('saveSession is a no-op when no KEK has been installed', async () => {
    // No initSessionKey here — save should silently no-op.
    await expect(saveSession('ch-1', { state: 'x' })).resolves.toBeUndefined();
    // And load returns null because the KEK is still missing.
    expect(await loadSession('ch-1')).toBeNull();
  });

  it('loadSession returns null when the channel has no entry', async () => {
    await initSessionKey('passphrase-derived-key');
    expect(await loadSession('not-a-channel')).toBeNull();
  });

  it('loadSession returns null when the KEK was rotated and cannot decrypt', async () => {
    await initSessionKey('kek-a');
    await saveSession('ch-1', { state: 'a' });

    // Reset and install a different KEK — old ciphertext stays in IDB
    // but the AES-GCM tag check should fail.
    resetSessionKey();
    await initSessionKey('kek-b');
    expect(await loadSession('ch-1')).toBeNull();
  });

  it('loadAllSessions returns every roundtrippable entry', async () => {
    await initSessionKey('passphrase');
    await saveSession('ch-1', { i: 1 });
    await saveSession('ch-2', { i: 2 });
    await saveSession('ch-3', { i: 3 });
    const all = await loadAllSessions();
    expect(all).toHaveLength(3);
    const ids = all.map(([id]) => id).sort();
    expect(ids).toEqual(['ch-1', 'ch-2', 'ch-3']);
  });

  it('loadAllSessions returns [] when no KEK is installed', async () => {
    expect(await loadAllSessions()).toEqual([]);
  });

  it('deleteSession removes the entry', async () => {
    await initSessionKey('passphrase');
    await saveSession('ch-1', { i: 1 });
    await deleteSession('ch-1');
    expect(await loadSession('ch-1')).toBeNull();
  });

  it('deleteSession of an unknown channel does not throw', async () => {
    await initSessionKey('passphrase');
    await expect(deleteSession('never-saved')).resolves.toBeUndefined();
  });

  it('resetSessionKey clears the cached KEK so subsequent loads return null', async () => {
    await initSessionKey('passphrase');
    await saveSession('ch-1', { i: 1 });
    resetSessionKey();
    expect(await loadSession('ch-1')).toBeNull();
  });

  it('saveSession overwrites an existing entry for the same channel', async () => {
    await initSessionKey('passphrase');
    await saveSession('ch-1', { v: 1 });
    await saveSession('ch-1', { v: 2 });
    const loaded = await loadSession('ch-1');
    expect(loaded).toEqual({ v: 2 });
  });
});
