// Coverage for the H-12c.1 pairwise-session store. Mirrors
// sessionStoreWorkerImpl but keyed by peerId instead of channelId.
// The CryptoKey is installed via setPairwiseSessionKey — which is
// also what sessionStoreWorkerImpl.initSessionKey() does internally —
// so we drive it via that path so the shared KEK setup behaviour is
// also exercised.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initSessionKey, resetSessionKey } from './sessionStoreWorkerImpl';
import {
  savePairwiseSession,
  loadPairwiseSession,
  loadAllPairwiseSessions,
  deletePairwiseSession,
  resetPairwiseSessionKey,
} from './pairwiseSessionStoreWorkerImpl';

async function wipeIDB() {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('dilla-sessions');
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

describe('pairwiseSessionStoreWorkerImpl', () => {
  beforeEach(async () => {
    resetSessionKey();
    resetPairwiseSessionKey();
    await wipeIDB();
  });

  afterEach(() => {
    resetSessionKey();
    resetPairwiseSessionKey();
  });

  it('savePairwiseSession+loadPairwiseSession roundtrip under the shared KEK', async () => {
    await initSessionKey('shared-kek');
    await savePairwiseSession('peer-1', { sess: 'abc', counter: 1 });
    const got = await loadPairwiseSession('peer-1');
    expect(got).toEqual({ sess: 'abc', counter: 1 });
  });

  it('savePairwiseSession no-ops when no KEK installed', async () => {
    // resetPairwiseSessionKey ran in beforeEach.
    await expect(savePairwiseSession('peer-1', { sess: 'x' })).resolves.toBeUndefined();
    expect(await loadPairwiseSession('peer-1')).toBeNull();
  });

  it('loadPairwiseSession returns null for unknown peer', async () => {
    await initSessionKey('shared-kek');
    expect(await loadPairwiseSession('nope')).toBeNull();
  });

  it('loadAllPairwiseSessions returns every entry', async () => {
    await initSessionKey('shared-kek');
    await savePairwiseSession('peer-a', { v: 1 });
    await savePairwiseSession('peer-b', { v: 2 });
    const all = await loadAllPairwiseSessions();
    expect(all).toHaveLength(2);
    const ids = all.map(([id]) => id).sort();
    expect(ids).toEqual(['peer-a', 'peer-b']);
  });

  it('loadAllPairwiseSessions returns [] when KEK missing', async () => {
    expect(await loadAllPairwiseSessions()).toEqual([]);
  });

  it('deletePairwiseSession removes the entry', async () => {
    await initSessionKey('shared-kek');
    await savePairwiseSession('peer-1', { v: 1 });
    await deletePairwiseSession('peer-1');
    expect(await loadPairwiseSession('peer-1')).toBeNull();
  });

  it('deletePairwiseSession of unknown peer does not throw', async () => {
    await initSessionKey('shared-kek');
    await expect(deletePairwiseSession('never-saved')).resolves.toBeUndefined();
  });

  it('rotating the KEK voids old ciphertext (returns null on load)', async () => {
    await initSessionKey('kek-a');
    await savePairwiseSession('peer-1', { v: 1 });
    resetSessionKey();
    resetPairwiseSessionKey();
    await initSessionKey('kek-b');
    expect(await loadPairwiseSession('peer-1')).toBeNull();
  });
});
