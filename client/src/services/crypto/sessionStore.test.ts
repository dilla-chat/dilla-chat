// Exercise sessionStore.ts main-thread path (Worker mocked away).

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./workerClient', () => ({
  getCryptoBackend: () => 'main',
  isSessionInitInWorker: () => false,
  sessionInitInWorker: vi.fn(async () => {}),
  sessionSaveInWorker: vi.fn(async () => {}),
  sessionLoadInWorker: vi.fn(async () => null),
  sessionLoadAllInWorker: vi.fn(async () => new Map()),
  sessionDeleteInWorker: vi.fn(async () => {}),
}));

import {
  saveGroupSession,
  loadGroupSession,
  loadAllGroupSessions,
  deleteGroupSession,
} from './sessionStore';
import { useAuthStore } from '../../stores/authStore';

beforeEach(async () => {
  useAuthStore.setState({ derivedKey: 'a'.repeat(64) } as never);
  const { default: FDBFactory } = await import('fake-indexeddb/lib/FDBFactory');
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new FDBFactory() as never;
});

describe('saveGroupSession / loadGroupSession', () => {
  it('module exports expected functions', () => {
    expect(typeof saveGroupSession).toBe('function');
    expect(typeof loadGroupSession).toBe('function');
  });

  it('round-trips a session object through encrypt+decrypt', async () => {
    await saveGroupSession('ch-1', { senderKey: 'abc', chainKey: 'xyz', counter: 42 });
    const loaded = await loadGroupSession('ch-1');
    expect(loaded).toEqual({ senderKey: 'abc', chainKey: 'xyz', counter: 42 });
  });

  it('returns null for a non-existent channel', async () => {
    const loaded = await loadGroupSession('does-not-exist');
    expect(loaded).toBeNull();
  });

  it('returns null when derivedKey is not set', async () => {
    useAuthStore.setState({ derivedKey: null } as never);
    const loaded = await loadGroupSession('ch-1');
    expect(loaded).toBeNull();
  });

  it('saveGroupSession is a no-op when derivedKey is null', async () => {
    useAuthStore.setState({ derivedKey: null } as never);
    await expect(saveGroupSession('ch-1', { x: 1 })).resolves.toBeUndefined();
  });

  it('overwrites an existing session', async () => {
    await saveGroupSession('ch-1', { v: 1 });
    await saveGroupSession('ch-1', { v: 2 });
    expect(await loadGroupSession('ch-1')).toEqual({ v: 2 });
  });
});

describe('loadAllGroupSessions', () => {
  it('returns all stored sessions', async () => {
    await saveGroupSession('ch-1', { a: 1 });
    await saveGroupSession('ch-2', { b: 2 });
    await saveGroupSession('ch-3', { c: 3 });

    const all = await loadAllGroupSessions();
    expect(all.size).toBe(3);
    expect(all.get('ch-1')).toEqual({ a: 1 });
    expect(all.get('ch-2')).toEqual({ b: 2 });
    expect(all.get('ch-3')).toEqual({ c: 3 });
  });

  it('returns empty Map when nothing saved', async () => {
    const all = await loadAllGroupSessions();
    expect(all.size).toBe(0);
  });

  it('returns empty Map when derivedKey missing', async () => {
    useAuthStore.setState({ derivedKey: null } as never);
    const all = await loadAllGroupSessions();
    expect(all.size).toBe(0);
  });
});

describe('deleteGroupSession', () => {
  it('removes a stored session', async () => {
    await saveGroupSession('ch-1', { x: 1 });
    expect(await loadGroupSession('ch-1')).toEqual({ x: 1 });
    await deleteGroupSession('ch-1');
    expect(await loadGroupSession('ch-1')).toBeNull();
  });

  it('is idempotent — deleting a non-existent session does not throw', async () => {
    await expect(deleteGroupSession('does-not-exist')).resolves.toBeUndefined();
  });

  it('only deletes the targeted session', async () => {
    await saveGroupSession('ch-1', { a: 1 });
    await saveGroupSession('ch-2', { b: 2 });
    await deleteGroupSession('ch-1');
    expect(await loadGroupSession('ch-1')).toBeNull();
    expect(await loadGroupSession('ch-2')).toEqual({ b: 2 });
  });
});

describe('encryption integrity', () => {
  it('different derivedKeys produce different ciphertexts', async () => {
    useAuthStore.setState({ derivedKey: 'a'.repeat(64) } as never);
    await saveGroupSession('ch-1', { secret: 'value' });
    useAuthStore.setState({ derivedKey: 'b'.repeat(64) } as never);
    const loaded = await loadGroupSession('ch-1');
    expect(loaded).toBeNull();
  });

  it('round-trips complex nested objects', async () => {
    const obj = {
      messageKeys: { 0: 'k0', 1: 'k1', 2: 'k2' },
      ratchet: { sending: { counter: 5, chain: 'xyz' }, receiving: {} },
      participants: ['me', 'u2', 'u3'],
    };
    await saveGroupSession('ch-1', obj);
    expect(await loadGroupSession('ch-1')).toEqual(obj);
  });
});
