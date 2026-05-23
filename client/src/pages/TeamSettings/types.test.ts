import { describe, it, expect } from 'vitest';
import { PERMISSION_FLAGS } from './types';

describe('TeamSettings/types', () => {
  it('PERMISSION_FLAGS contains 10 entries matching server PERM_* table', () => {
    expect(PERMISSION_FLAGS).toHaveLength(10);
  });

  it('every bit is a distinct power of two', () => {
    const bits = PERMISSION_FLAGS.map((p) => p.bit);
    // Each bit must be a power of 2 (single bit set).
    for (const b of bits) {
      expect(b & (b - 1)).toBe(0);
      expect(b).toBeGreaterThan(0);
    }
    expect(new Set(bits).size).toBe(bits.length);
  });

  it('bits are listed in ascending order (matches server PERM_* table order)', () => {
    const bits = PERMISSION_FLAGS.map((p) => p.bit);
    for (let i = 1; i < bits.length; i++) {
      expect(bits[i]).toBeGreaterThan(bits[i - 1]);
    }
  });

  it('admin bit is 0x001 (matches server PERM_ADMIN)', () => {
    expect(PERMISSION_FLAGS[0].bit).toBe(0x001);
    expect(PERMISSION_FLAGS[0].label).toBe('permissions.admin');
  });

  it('manageMembers comes before manageRoles (the order that bit-swapped historically)', () => {
    const labels = PERMISSION_FLAGS.map((p) => p.label);
    expect(labels.indexOf('permissions.manageMembers')).toBeLessThan(
      labels.indexOf('permissions.manageRoles'),
    );
  });

  it('every entry has a non-empty translation key', () => {
    for (const p of PERMISSION_FLAGS) {
      expect(p.label).toMatch(/^permissions\./);
    }
  });

  it('full admin mask covers all flags', () => {
    const full = PERMISSION_FLAGS.reduce((acc, p) => acc | p.bit, 0);
    // 10 contiguous bits starting at 0x001 → 0x3FF
    expect(full).toBe(0x3ff);
  });
});
