// Web Worker for Signal Protocol crypto — F3 / DR-XSS-1 / DR-SUPPLY-1.
//
// Goal (per architecture review §8.4 bullet 1): keep ratchet keys and
// session state off the main thread so an XSS in a UI component can't
// touch them. This file is the worker side; `cryptoWorkerClient.ts` is
// the main-thread RPC wrapper.
//
// Current migration scope (deliberate scope-down — see brief F3):
//   - Safety-number computation (~SHA-256 × 5200 of two identity pubkeys).
//
// Why safety numbers first:
//   - No secret state crosses postMessage — both inputs are public
//     identity keys. The migration proves the worker pipeline works
//     without risking breakage in encrypt/decrypt during the rollout.
//   - It is the most CPU-bound op in the crypto module (10k iterations
//     of SHA-256), so moving it off the main thread also helps
//     responsiveness during the Settings → Identity reveal panel.
//
// Future migrations (TODO follow-up):
//   - X3DH initiate / respond — needs prekey-secret access in the worker.
//   - Double Ratchet encrypt / decrypt — needs ratchet state.
//   - Group sender-key derivation / rotation.
// All three need the IndexedDB handle to live in the worker, not the
// main thread, so a CRYPTO_BACKEND='worker' rollout flag will gate
// them when implemented.

import { generateSafetyNumber } from './safetyNumbers';
import { fromBase64 } from './helpers';
import {
  initSessionKey,
  resetSessionKey,
  saveSession,
  loadSession,
  loadAllSessions,
  deleteSession,
} from './sessionStoreWorkerImpl';

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

self.addEventListener('message', async (ev: MessageEvent<RpcRequest>) => {
  const { id, op, payload } = ev.data || ({} as RpcRequest);
  try {
    const result = await dispatch(op, payload);
    const response: RpcResponse = { id, ok: true, result };
    (self as unknown as Worker).postMessage(response);
  } catch (err) {
    const response: RpcResponse = {
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    (self as unknown as Worker).postMessage(response);
  }
});

async function dispatch(op: string, payload: unknown): Promise<unknown> {
  switch (op) {
    case 'safetyNumber.compute':
      return await opSafetyNumber(payload as SafetyNumberRequest);
    // H-12: encrypted IndexedDB session store ops. The worker holds
    // the derivedKey + the DB handle so a main-thread XSS can't read
    // raw session ciphertext or extract the KEK after init.
    case 'session.init': {
      const { derivedKey } = payload as { derivedKey: string };
      await initSessionKey(derivedKey);
      return null;
    }
    case 'session.reset': {
      resetSessionKey();
      return null;
    }
    case 'session.save': {
      const { channelId, sessionJson } = payload as {
        channelId: string;
        sessionJson: Record<string, unknown>;
      };
      await saveSession(channelId, sessionJson);
      return null;
    }
    case 'session.load': {
      const { channelId } = payload as { channelId: string };
      return await loadSession(channelId);
    }
    case 'session.loadAll':
      return await loadAllSessions();
    case 'session.delete': {
      const { channelId } = payload as { channelId: string };
      await deleteSession(channelId);
      return null;
    }
    case 'ping':
      return 'pong';
    default:
      throw new Error('unknown op: ' + op);
  }
}

interface SafetyNumberRequest {
  ourIdentityKey: string; // base64
  ourId: string;
  theirIdentityKey: string; // base64
  theirId: string;
}

async function opSafetyNumber(req: SafetyNumberRequest): Promise<string> {
  // All inputs are public — the identity public keys + stable IDs.
  // No secret material crosses postMessage in either direction.
  const ours = fromBase64(req.ourIdentityKey);
  const theirs = fromBase64(req.theirIdentityKey);
  return generateSafetyNumber(ours, req.ourId, theirs, req.theirId);
}
