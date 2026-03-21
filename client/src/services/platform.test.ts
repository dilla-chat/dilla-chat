import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isTauri, getOriginServerUrl } from './platform';

describe('isTauri', () => {
  afterEach(() => {
    // Clean up
    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it('returns false when __TAURI_INTERNALS__ is absent', () => {
    expect(isTauri()).toBe(false);
  });

  it('returns true when __TAURI_INTERNALS__ is set', () => {
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    expect(isTauri()).toBe(true);
  });
});

describe('getOriginServerUrl', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it('returns window.location.origin in browser mode', () => {
    expect(getOriginServerUrl()).toBe(globalThis.location.origin);
  });

  it('returns null in Tauri mode', () => {
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    expect(getOriginServerUrl()).toBeNull();
  });
});

describe('getDataDir', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it('returns indexeddb in browser mode', async () => {
    // getDataDir is already imported at module level, use the direct import
    const { getDataDir } = await import('./platform');
    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
    const dir = await getDataDir();
    expect(dir).toBe('indexeddb');
  });

  it('returns fallback path when in Tauri mode', async () => {
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const { getDataDir } = await import('./platform');
    const dir = await getDataDir();
    // Tauri import will fail in test env, so falls back to './dilla-data'
    expect(dir).toBe('./dilla-data');
  });
});
