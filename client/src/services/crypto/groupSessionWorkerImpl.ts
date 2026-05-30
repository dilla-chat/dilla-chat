// H-12b: worker-scope implementation of the group-session crypto ops.
//
// This file is imported BY `worker.ts` (worker scope). The main
// thread should NEVER import it directly — instead it sends RPCs via
// `workerClient.ts` so the GroupSession state never enters the main
// heap.
//
// Each op follows the same shape:
//   1. Load the session from the worker-side encrypted IDB store
//      (H-12a, `sessionStoreWorkerImpl.ts`).
//   2. Deserialize via GroupSession.fromJSON.
//   3. Mutate the session (encrypt / decrypt / rotate / process).
//   4. Save the new JSON back to IDB.
//   5. Return only the public result (plaintext bytes, the wire
//      message, the new distribution payload — never the raw
//      session state).
//
// The in-worker session cache is a Map keyed by channelId. Loads
// hit IDB on miss, then cache the deserialized instance. This avoids
// re-deserializing on every encrypt/decrypt for active channels but
// is bounded by process lifetime.

import { GroupSession } from './groupSession';
import type { SenderKeyDistribution, GroupMessageData } from './groupSession';
import { loadSession, saveSession } from './sessionStoreWorkerImpl';
import { fromBase64, toBase64 } from './helpers';

const cache = new Map<string, GroupSession>();

async function getOrLoad(channelId: string): Promise<GroupSession | null> {
  const hit = cache.get(channelId);
  if (hit) return hit;
  const stored = await loadSession(channelId);
  if (!stored) return null;
  try {
    const gs = GroupSession.fromJSON(stored);
    cache.set(channelId, gs);
    return gs;
  } catch {
    return null;
  }
}

/** Ensure a session exists for `channelId` — create one if missing.
 *  Used by the encrypt + getDistribution paths where a fresh session
 *  is the correct default. */
async function getOrCreate(
  channelId: string,
  senderId: string,
): Promise<GroupSession> {
  const existing = await getOrLoad(channelId);
  if (existing) return existing;
  const fresh = await GroupSession.create(channelId, senderId);
  cache.set(channelId, fresh);
  await saveSession(channelId, fresh.toJSON()).catch(() => {});
  return fresh;
}

/** H-12b: persist + cache. Wraps both writes so a caller can't
 *  forget the cache invariant. */
async function persist(channelId: string, gs: GroupSession): Promise<void> {
  cache.set(channelId, gs);
  await saveSession(channelId, gs.toJSON()).catch(() => {});
}

// ── Op handlers exposed via worker dispatch ─────────────────────

/** Encrypt a base64-encoded plaintext for the channel. Returns the
 *  base64-encoded GroupMessageData JSON (matches the legacy
 *  `cryptoManager.encryptChannel` wire shape). */
export async function opEncrypt(channelId: string, senderId: string, plaintextB64: string): Promise<string> {
  const gs = await getOrCreate(channelId, senderId);
  const plaintext = fromBase64(plaintextB64);
  const msg = await gs.encrypt(plaintext);
  await persist(channelId, gs);
  const wire = JSON.stringify(msg);
  return toBase64(new TextEncoder().encode(wire));
}

/** Decrypt the base64-encoded GroupMessageData wire payload. Returns
 *  the plaintext as a base64-encoded string. */
export async function opDecrypt(channelId: string, ciphertextB64: string): Promise<string> {
  const gs = await getOrLoad(channelId);
  if (!gs) {
    throw new Error(`No group session for channel ${channelId}`);
  }
  const wire = new TextDecoder().decode(fromBase64(ciphertextB64));
  const msg: GroupMessageData = JSON.parse(wire);
  const plaintext = await gs.decrypt(msg);
  await persist(channelId, gs);
  return toBase64(plaintext);
}

/** Apply a peer's sender-key distribution to our session for the
 *  channel. If no session exists yet we create one (matches the
 *  fix-the-race comment in cryptoManager.processSenderKey). */
export async function opProcessDistribution(
  channelId: string,
  ownSenderId: string,
  distributionJson: string,
): Promise<void> {
  const dist: SenderKeyDistribution = JSON.parse(distributionJson);
  const gs = await getOrCreate(channelId, ownSenderId);
  gs.processDistribution(dist);
  await persist(channelId, gs);
}

/** Rotate our own sender key for `channelId` and return the new
 *  distribution message (JSON string) callers can broadcast to
 *  remaining members. */
export async function opRotateMyKey(
  channelId: string,
  removedUserId: string,
): Promise<string | null> {
  const gs = await getOrLoad(channelId);
  if (!gs) return null;
  gs.removeMember(removedUserId);
  await gs.rotateMyKey();
  await persist(channelId, gs);
  return JSON.stringify(gs.createDistributionMessage());
}

/** Return our current distribution message for `channelId`,
 *  creating the session if needed. */
export async function opGetDistribution(
  channelId: string,
  senderId: string,
): Promise<string> {
  const gs = await getOrCreate(channelId, senderId);
  return JSON.stringify(gs.createDistributionMessage());
}

/** Test-only: drop all cached sessions. Forces the next op to
 *  reload from IDB. */
export function resetSessionCache(): void {
  cache.clear();
}
