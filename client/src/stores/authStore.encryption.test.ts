import { describe, it, expect, beforeEach } from 'vitest';
import { restoreDerivedKey, useAuthStore } from './authStore';

describe('authStore derivedKey encryption', () => {
  beforeEach(() => {
    sessionStorage.clear();
    useAuthStore.getState().logout();
  });

  it('restoreDerivedKey returns null when nothing stored', async () => {
    const result = await restoreDerivedKey();
    expect(result).toBeNull();
  });

  it('restoreDerivedKey returns null for corrupt data', async () => {
    sessionStorage.setItem('dilla:derivedKey:enc', 'not-valid-base64!!!');
    const result = await restoreDerivedKey();
    expect(result).toBeNull();
  });

  it('setDerivedKey stores encrypted value in sessionStorage', async () => {
    useAuthStore.getState().setDerivedKey('test-key-123');
    // Wait for async persist
    await new Promise((r) => setTimeout(r, 100));
    const stored = sessionStorage.getItem('dilla:derivedKey:enc');
    // Should be stored but NOT as plaintext
    expect(stored).not.toBeNull();
    expect(stored).not.toBe('test-key-123');
    expect(stored!.length).toBeGreaterThan(20); // base64 of iv+ciphertext
  });

  it('roundtrip: setDerivedKey then restoreDerivedKey returns same value', async () => {
    useAuthStore.getState().setDerivedKey('my-secret-derived-key');
    await new Promise((r) => setTimeout(r, 100));
    const restored = await restoreDerivedKey();
    expect(restored).toBe('my-secret-derived-key');
  });

  it('logout clears encrypted derivedKey from sessionStorage', async () => {
    useAuthStore.getState().setDerivedKey('key-to-clear');
    await new Promise((r) => setTimeout(r, 100));
    expect(sessionStorage.getItem('dilla:derivedKey:enc')).not.toBeNull();
    useAuthStore.getState().logout();
    await new Promise((r) => setTimeout(r, 100));
    expect(sessionStorage.getItem('dilla:derivedKey:enc')).toBeNull();
  });
});
