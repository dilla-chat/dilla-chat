// H-12c.2: worker-scope encrypt/decrypt for 1:1 Double Ratchet
// sessions. Mirrors the group-session impl from H-12b — load state
// from the worker IDB, mutate via RatchetSession, persist.
//
// What stays on the main thread for now (deferred to H-12d):
//   - X3DH initiate (uses identity DH private key + peer prekey
//     bundle). Main thread creates the RatchetSession, then calls
//     `pairwiseSessionSaveInWorker(peerId, session.toJSON())` to
//     ship it here.
//   - X3DH respond (Bob bootstrap from an incoming message's
//     bootstrap header). Same pattern — main thread runs it, ships
//     the new session to the worker.
//
// Once H-12d ships, X3DH itself will run in the worker and identity
// DH + prekey secrets will live exclusively here.

import { RatchetSession } from './ratchet';
import type { RatchetMessage } from './ratchet';
import {
  savePairwiseSession,
  loadPairwiseSession,
} from './pairwiseSessionStoreWorkerImpl';
import { fromBase64, toBase64 } from './helpers';

const cache = new Map<string, RatchetSession>();

async function getCached(peerId: string): Promise<RatchetSession | null> {
  const hit = cache.get(peerId);
  if (hit) return hit;
  const stored = await loadPairwiseSession(peerId);
  if (!stored) return null;
  try {
    const session = RatchetSession.fromJSON(stored);
    cache.set(peerId, session);
    return session;
  } catch {
    return null;
  }
}

async function persist(peerId: string, session: RatchetSession): Promise<void> {
  cache.set(peerId, session);
  await savePairwiseSession(peerId, session.toJSON()).catch(() => {});
}

/** Encrypt a base64-encoded plaintext for `peerId`. Returns base64
 *  of the JSON-serialized RatchetMessage — matches the legacy
 *  `cryptoManager.encryptDM` wire shape. Throws when no session
 *  exists yet; main thread must initiate before the first encrypt. */
export async function opPairwiseEncrypt(
  peerId: string,
  plaintextB64: string,
): Promise<string> {
  const session = await getCached(peerId);
  if (!session) {
    throw new Error(`No pairwise session for peer ${peerId}`);
  }
  const plaintext = fromBase64(plaintextB64);
  const msg = await session.encrypt(plaintext);
  await persist(peerId, session);
  return toBase64(new TextEncoder().encode(JSON.stringify(msg)));
}

/** Decrypt a base64-encoded RatchetMessage wire payload. Returns
 *  base64 of the plaintext. Throws when no session exists and the
 *  message carries no X3DH bootstrap header (main thread retries
 *  the bootstrap path then).
 *
 *  Note on the X3DH-bootstrap fallback: the legacy code on the main
 *  thread calls `bootstrapBobSession` when the existing session
 *  fails and the message has an x3dh header. In worker mode the
 *  worker has no access to prekey secrets, so it just signals back
 *  and the main thread does the bootstrap + ships the new session
 *  via pairwiseSessionSaveInWorker before retrying decrypt. */
export async function opPairwiseDecrypt(
  peerId: string,
  ciphertextB64: string,
): Promise<{ ok: true; plaintextB64: string } | { ok: false; needsBootstrap: boolean }> {
  const session = await getCached(peerId);
  const wire = new TextDecoder().decode(fromBase64(ciphertextB64));
  const msg: RatchetMessage = JSON.parse(wire);

  if (session) {
    try {
      const plaintext = await session.decrypt(msg);
      await persist(peerId, session);
      return { ok: true, plaintextB64: toBase64(plaintext) };
    } catch (err) {
      // Same fall-through rule as the main-thread path: if the
      // header carries an X3DH bootstrap, signal the caller to
      // re-bootstrap. Otherwise re-throw.
      if (!msg.header.x3dh) throw err;
      return { ok: false, needsBootstrap: true };
    }
  }

  // No existing session — caller must bootstrap before retrying.
  if (msg.header.x3dh) {
    return { ok: false, needsBootstrap: true };
  }
  throw new Error(`No session for peer ${peerId} and message has no X3DH bootstrap`);
}

/** Test-only: drop the in-worker pairwise session cache. */
export function resetPairwiseSessionCache(): void {
  cache.clear();
}
