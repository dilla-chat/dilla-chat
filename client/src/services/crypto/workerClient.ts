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
  const toB64 = (b: Uint8Array) => {
    let s = '';
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s);
  };
  return call<string>('safetyNumber.compute', {
    ourIdentityKey: toB64(ourIdentityKey),
    ourId,
    theirIdentityKey: toB64(theirIdentityKey),
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
}
