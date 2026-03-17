import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isTauri, getOriginServerUrl } from './platform';

describe('isTauri', () => {
  afterEach(() => {
    // Clean up
    delete (window as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it('returns false when __TAURI_INTERNALS__ is absent', () => {
    expect(isTauri()).toBe(false);
  });

  it('returns true when __TAURI_INTERNALS__ is set', () => {
    (window as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    expect(isTauri()).toBe(true);
  });
});

describe('getOriginServerUrl', () => {
  beforeEach(() => {
    delete (window as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it('returns window.location.origin in browser mode', () => {
    expect(getOriginServerUrl()).toBe(window.location.origin);
  });

  it('returns null in Tauri mode', () => {
    (window as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    expect(getOriginServerUrl()).toBeNull();
  });
});
