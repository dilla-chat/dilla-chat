import { describe, it, expect } from 'vitest';
import { usernameColor, getInitials } from './colors';

describe('usernameColor', () => {
  it('returns a hex color from the palette', () => {
    const color = usernameColor('alice');
    expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('is deterministic — same input returns same output', () => {
    expect(usernameColor('bob')).toBe(usernameColor('bob'));
  });

  it('handles empty string by defaulting to Unknown', () => {
    const color = usernameColor('');
    expect(color).toMatch(/^#[0-9a-f]{6}$/);
    expect(color).toBe(usernameColor('Unknown'));
  });

  it('produces different colors for different usernames', () => {
    const colors = new Set(['alice', 'bob', 'charlie', 'diana', 'eve'].map(usernameColor));
    expect(colors.size).toBeGreaterThan(1);
  });
});

describe('getInitials', () => {
  it('returns first 2 chars uppercased', () => {
    expect(getInitials('alice')).toBe('AL');
  });

  it('handles single char', () => {
    expect(getInitials('b')).toBe('B');
  });

  it('returns ? for empty string', () => {
    expect(getInitials('')).toBe('?');
  });

  it('uppercases lowercase input', () => {
    expect(getInitials('zx')).toBe('ZX');
  });
});
