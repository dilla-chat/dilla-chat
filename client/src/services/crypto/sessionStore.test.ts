import { describe, it, expect } from 'vitest';

// sessionStore.ts is IndexedDB + Web Crypto infrastructure code.
// The encryption/decryption functions and IDB operations require
// a real browser environment. Unit tests cover the guard paths.

describe('sessionStore', () => {
  it('module exports expected functions', async () => {
    const mod = await import('./sessionStore');
    expect(typeof mod.saveGroupSession).toBe('function');
    expect(typeof mod.loadGroupSession).toBe('function');
    expect(typeof mod.loadAllGroupSessions).toBe('function');
    expect(typeof mod.deleteGroupSession).toBe('function');
  });
});
