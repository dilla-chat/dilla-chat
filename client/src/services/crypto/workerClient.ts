// Main-thread RPC client for the crypto Web Worker — F3.
//
// Wraps the worker behind a function-shaped API so existing crypto.ts
// surfaces can switch backends without touching the call sites.
//
// Design notes:
//   - Single shared worker instance (lazy-spawned on first call). The
//     `import.meta.url` pattern is what Vite recognises to bundle the
//     worker as a separate chunk.
//   - Strict request/response correlation via a monotonically increasing
//     id. Out-of-order responses are tolerated.
//   - Timeouts on the request side so a wedged worker doesn't pin a
//     promise forever. Safety-number computation runs in <50 ms on
//     reasonable hardware; we use 10 s as a very generous upper bound.

interface RpcRequest {
  id: number;
  op: string;
  payload: unknown;
}

interface RpcResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface PendingCall {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, PendingCall>();
const RPC_TIMEOUT_MS = 10_000;

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.addEventListener('message', (ev: MessageEvent<RpcResponse>) => {
    const { id, ok, result, error } = ev.data || ({} as RpcResponse);
    const call = pending.get(id);
    if (!call) return; // late response, ignore
    pending.delete(id);
    clearTimeout(call.timer);
    if (ok) {
      call.resolve(result);
    } else {
      call.reject(new Error(error || 'crypto worker error'));
    }
  });
  worker.addEventListener('error', (ev) => {
    // Fail every pending call — the worker is in a bad state.
    const err = new Error('[crypto-worker] ' + (ev.message || 'error'));
    for (const [, call] of pending) {
      clearTimeout(call.timer);
      call.reject(err);
    }
    pending.clear();
    worker?.terminate();
    worker = null;
  });
  return worker;
}

function call<T>(op: string, payload: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const w = getWorker();
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('crypto worker timeout: ' + op));
    }, RPC_TIMEOUT_MS);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    const req: RpcRequest = { id, op, payload };
    w.postMessage(req);
  });
}

// CRYPTO_BACKEND — feature flag for the worker migration. Default is
// 'worker' in production builds; tests force 'main' via setBackend()
// so the in-thread implementation stays exercised. See architecture
// review §8.4 bullet 1.
type Backend = 'worker' | 'main';
let backend: Backend = 'worker';

export function setCryptoBackend(b: Backend): void {
  backend = b;
}

export function getCryptoBackend(): Backend {
  return backend;
}

/**
 * Compute a safety number for a contact via the crypto worker.
 *
 * Falls through to the main-thread implementation when:
 *   - CRYPTO_BACKEND is 'main' (tests).
 *   - Worker spawn fails (no `Worker` global, e.g. SSR or hostile
 *     iframe).
 *
 * Inputs are all PUBLIC (identity public keys + stable IDs) — no
 * secret material crosses postMessage.
 */
export async function safetyNumberInWorker(
  ourIdentityKey: Uint8Array,
  ourId: string,
  theirIdentityKey: Uint8Array,
  theirId: string,
): Promise<string> {
  if (backend === 'main' || typeof Worker === 'undefined') {
    const { generateSafetyNumber } = await import('./safetyNumbers');
    return generateSafetyNumber(ourIdentityKey, ourId, theirIdentityKey, theirId);
  }
  return call<string>('safetyNumber.compute', {
    ourIdentityKey: bytesToB64(ourIdentityKey),
    ourId,
    theirIdentityKey: bytesToB64(theirIdentityKey),
    theirId,
  });
}

// ── H-12: encrypted IndexedDB session store via the worker ────────
//
// Mirrors the legacy main-thread `sessionStore.ts` API but routes
// every call through the worker so the AES-GCM KEK + IndexedDB
// handle never sit on the main heap after init. A main-thread XSS
// post-init can't extract the KEK (it lives only in the worker's
// CryptoKey cache) or read raw ciphertext rows from IDB directly.
//
// Init: send the derivedKey ONCE at boot. The worker caches a
// non-extractable CryptoKey derived from it; the raw string can be
// dropped by the caller afterward.

let sessionInitDone = false;

export async function sessionInitInWorker(derivedKey: string): Promise<void> {
  if (backend === 'main' || typeof Worker === 'undefined') {
    return;
  }
  await call<null>('session.init', { derivedKey });
  sessionInitDone = true;
}

export function isSessionInitInWorker(): boolean {
  return sessionInitDone;
}

export async function sessionSaveInWorker(
  channelId: string,
  sessionJson: object,
): Promise<void> {
  await call<null>('session.save', { channelId, sessionJson });
}

export async function sessionLoadInWorker(
  channelId: string,
): Promise<Record<string, unknown> | null> {
  return call<Record<string, unknown> | null>('session.load', { channelId });
}

export async function sessionLoadAllInWorker(): Promise<
  Map<string, Record<string, unknown>>
> {
  const entries = await call<Array<[string, Record<string, unknown>]>>(
    'session.loadAll',
    null,
  );
  return new Map(entries);
}

export async function sessionDeleteInWorker(channelId: string): Promise<void> {
  await call<null>('session.delete', { channelId });
}

// ── H-12b: group-session crypto via the worker ────────────────────
//
// Main-thread shims for the encrypt/decrypt/processDistribution/
// rotateMyKey/getDistribution ops. Each returns base64-encoded
// payloads to match the legacy main-thread wire shape so
// cryptoManager.ts call sites switch backends with a one-line
// branch.

export async function groupSessionEncryptInWorker(
  channelId: string,
  senderId: string,
  plaintextB64: string,
): Promise<string> {
  return call<string>('groupSession.encrypt', { channelId, senderId, plaintextB64 });
}

export async function groupSessionDecryptInWorker(
  channelId: string,
  ciphertextB64: string,
): Promise<string> {
  return call<string>('groupSession.decrypt', { channelId, ciphertextB64 });
}

export async function groupSessionProcessDistributionInWorker(
  channelId: string,
  ownSenderId: string,
  distributionJson: string,
): Promise<void> {
  await call<null>('groupSession.processDistribution', {
    channelId,
    ownSenderId,
    distributionJson,
  });
}

export async function groupSessionRotateMyKeyInWorker(
  channelId: string,
  removedUserId: string,
): Promise<string | null> {
  return call<string | null>('groupSession.rotateMyKey', { channelId, removedUserId });
}

export async function groupSessionGetDistributionInWorker(
  channelId: string,
  senderId: string,
): Promise<string> {
  return call<string>('groupSession.getDistribution', { channelId, senderId });
}

// ── H-12c: pairwise (1:1 Double Ratchet) session ops ──────────────

export async function pairwiseSessionSaveInWorker(
  peerId: string,
  sessionJson: object,
): Promise<void> {
  await call<null>('pairwiseSession.save', { peerId, sessionJson });
}

export async function pairwiseSessionLoadInWorker(
  peerId: string,
): Promise<Record<string, unknown> | null> {
  return call<Record<string, unknown> | null>('pairwiseSession.load', { peerId });
}

export async function pairwiseSessionLoadAllInWorker(): Promise<
  Map<string, Record<string, unknown>>
> {
  const entries = await call<Array<[string, Record<string, unknown>]>>(
    'pairwiseSession.loadAll',
    null,
  );
  return new Map(entries);
}

export async function pairwiseSessionDeleteInWorker(peerId: string): Promise<void> {
  await call<null>('pairwiseSession.delete', { peerId });
}

export async function pairwiseSessionEncryptInWorker(
  peerId: string,
  plaintextB64: string,
): Promise<string> {
  return call<string>('pairwiseSession.encrypt', { peerId, plaintextB64 });
}

export type PairwiseDecryptResult =
  | { ok: true; plaintextB64: string }
  | { ok: false; needsBootstrap: boolean };

export async function pairwiseSessionDecryptInWorker(
  peerId: string,
  ciphertextB64: string,
): Promise<PairwiseDecryptResult> {
  return call<PairwiseDecryptResult>('pairwiseSession.decrypt', { peerId, ciphertextB64 });
}

// ── H-12d.1: identity DH wrap/unwrap via worker ───────────────────

let identityInitDone = false;

/** Ship the user's non-extractable identity DH private CryptoKey to
 *  the worker. The public-key bytes ride alongside so the X3DH
 *  initiate op inside the worker can include them in the bootstrap
 *  header without re-deriving. Idempotent on the main-thread side. */
export async function identityInitInWorker(
  identityDhPrivateKey: CryptoKey,
  identityDhPublicKeyBytes?: Uint8Array,
): Promise<void> {
  if (backend === 'main' || typeof Worker === 'undefined') return;
  if (identityInitDone) return;
  await call<null>('identity.init', {
    identityDhPrivateKey,
    identityDhPublicKeyB64: identityDhPublicKeyBytes
      ? bytesToB64(identityDhPublicKeyBytes)
      : undefined,
  });
  identityInitDone = true;
}

export function isIdentityInitInWorker(): boolean {
  return identityInitDone;
}

export async function wrapForPeerInWorker(
  peerIdentityDhPub: Uint8Array,
  plaintext: Uint8Array,
): Promise<string> {
  return call<string>('identity.wrapForPeer', {
    peerIdentityDhPubB64: bytesToB64(peerIdentityDhPub),
    plaintextB64: bytesToB64(plaintext),
  });
}

export async function unwrapFromPeerInWorker(
  peerIdentityDhPub: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const plaintextB64 = await call<string>('identity.unwrapFromPeer', {
    peerIdentityDhPubB64: bytesToB64(peerIdentityDhPub),
    ciphertextB64: bytesToB64(ciphertext),
  });
  return b64ToBytes(plaintextB64);
}

// ── H-12d.2: prekey vault + X3DH bootstrap ────────────────────────

export async function prekeyVaultSaveInWorker(
  signedPrekeyPrivate: Uint8Array,
  oneTimePrekeyPrivates: Uint8Array[],
): Promise<void> {
  await call<null>('prekeyVault.save', {
    signedPrekeyPrivateB64: bytesToB64(signedPrekeyPrivate),
    oneTimePrekeyPrivatesB64: oneTimePrekeyPrivates.map(bytesToB64),
  });
}

export async function prekeyVaultClearInWorker(): Promise<void> {
  await call<null>('prekeyVault.clear', null);
}

// Type that mirrors X3DHBootstrap from ratchet.ts to avoid leaking
// a cross-bundle import here. Caller stamps these fields in.
export interface X3DHBootstrapWire {
  identity_dh_key: number[];
  ephemeral_key: number[];
  one_time_prekey_index: number | null;
}

export async function pairwiseSessionBootstrapAliceInWorker(
  peerId: string,
  peerBundle: Record<string, unknown>,
): Promise<X3DHBootstrapWire> {
  return call<X3DHBootstrapWire>('pairwiseSession.bootstrapAlice', { peerId, peerBundle });
}

export async function pairwiseSessionBootstrapBobInWorker(
  peerId: string,
  bootstrap: X3DHBootstrapWire,
): Promise<void> {
  await call<null>('pairwiseSession.bootstrapBob', { peerId, bootstrap });
}

function bytesToB64(b: Uint8Array): string {
  let s = '';
  for (const byte of b) s += String.fromCodePoint(byte);
  return btoa(s);
}

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.codePointAt(i) ?? 0;
  return out;
}

/** Test/teardown hook — terminates the worker so subsequent calls respawn. */
export function __resetCryptoWorkerForTests(): void {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  for (const [, call] of pending) {
    clearTimeout(call.timer);
    call.reject(new Error('worker reset'));
  }
  pending.clear();
  nextId = 1;
  sessionInitDone = false;
  identityInitDone = false;
}
