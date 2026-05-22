import { describe, it, expect } from 'vitest';
import { randomTail, shortId, randomInt } from './randomId';

describe('randomTail', () => {
  it('returns the requested length by default (6)', () => {
    const out = randomTail();
    expect(out).toHaveLength(6);
  });

  it('honours an explicit length', () => {
    expect(randomTail(8)).toHaveLength(8);
    expect(randomTail(2)).toHaveLength(2);
  });

  it('produces base36 characters only', () => {
    for (let i = 0; i < 20; i++) {
      expect(randomTail()).toMatch(/^[0-9a-z]{6}$/);
    }
  });

  it('produces distinct values across calls', () => {
    // 1k draws with a 32-bit source — collision probability is negligible.
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(randomTail());
    expect(seen.size).toBeGreaterThan(990);
  });

  it('falls back to Date.now()-derived tail when crypto is unavailable', () => {
    const orig = globalThis.crypto;
    // Temporarily wipe the CSPRNG so the SSR fallback runs.
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try {
      const out = randomTail(6);
      expect(out).toHaveLength(6);
      expect(out).toMatch(/^[0-9a-z]{6}$/);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: orig, configurable: true });
    }
  });
});

describe('shortId', () => {
  it('builds `<prefix>-<timestamp>-<rand>`', () => {
    const id = shortId('up');
    expect(id).toMatch(/^up-\d+-[0-9a-z]{6}$/);
  });

  it('uses the prefix verbatim', () => {
    expect(shortId('toast')).toMatch(/^toast-/);
  });

  it('handles empty prefix', () => {
    expect(shortId('')).toMatch(/^-\d+-[0-9a-z]{6}$/);
  });
});

describe('randomInt', () => {
  it('returns 0 when max <= 0', () => {
    expect(randomInt(0)).toBe(0);
    expect(randomInt(-5)).toBe(0);
  });

  it('returns a value in [0, max)', () => {
    for (let i = 0; i < 100; i++) {
      const v = randomInt(10);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(10);
    }
  });

  it('covers the full range with enough draws', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) seen.add(randomInt(4));
    expect(seen.size).toBe(4); // 0, 1, 2, 3 should all show up
  });

  it('returns 0 when crypto is unavailable', () => {
    const orig = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try {
      expect(randomInt(10)).toBe(0);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: orig, configurable: true });
    }
  });
});
