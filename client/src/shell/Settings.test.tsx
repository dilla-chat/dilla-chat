// Settings.tsx is a 2529-LOC modal port; the full default export
// triggers the same Zustand re-render loop as ChatApp under jsdom.
// Cover the exported tab tables + permsSummary helper instead.

import { describe, it, expect } from 'vitest';
import { USER_TABS, TEAM_TABS, PERM_FLAGS, permsSummary } from './Settings';

describe('Settings tab tables', () => {
  it('USER_TABS contains the seven user-scope tabs', () => {
    expect(USER_TABS.map((t) => t.id)).toEqual([
      'account', 'devices', 'notif', 'voice', 'appear', 'privacy', 'keys',
    ]);
  });

  it('TEAM_TABS contains the seven team-scope tabs', () => {
    expect(TEAM_TABS.map((t) => t.id)).toEqual([
      'team', 'invites', 'members', 'roles', 'integrations', 'federation', 'audit',
    ]);
  });

  it('every tab has both id and name', () => {
    for (const t of [...USER_TABS, ...TEAM_TABS]) {
      expect(typeof t.id).toBe('string');
      expect(typeof t.name).toBe('string');
      expect(t.id.length).toBeGreaterThan(0);
      expect(t.name.length).toBeGreaterThan(0);
    }
  });

  it('USER_TABS and TEAM_TABS have disjoint id sets', () => {
    const u = new Set(USER_TABS.map((t) => t.id));
    for (const t of TEAM_TABS) expect(u.has(t.id)).toBe(false);
  });
});

describe('Settings PERM_FLAGS', () => {
  it('contains the 9 user-facing permission flags', () => {
    expect(PERM_FLAGS).toHaveLength(9);
  });

  it('every bit is a distinct power of two', () => {
    const bits = PERM_FLAGS.map((f) => f.bit);
    for (const b of bits) {
      expect(b > 0).toBe(true);
      expect(b & (b - 1)).toBe(0);
    }
    expect(new Set(bits).size).toBe(bits.length);
  });

  it('admin is bit 0 (least-significant)', () => {
    expect(PERM_FLAGS[0].bit).toBe(1);
    expect(PERM_FLAGS[0].key).toBe('admin');
  });
});

describe('permsSummary', () => {
  it('returns "all permissions" when the admin bit is set', () => {
    // Even with other bits, admin short-circuits to "all permissions".
    expect(permsSummary(0b1)).toBe('all permissions');
    expect(permsSummary(0b111)).toBe('all permissions');
  });

  it('returns "no permissions" for 0', () => {
    expect(permsSummary(0)).toBe('no permissions');
  });

  it('returns a single lowercase label for a single bit', () => {
    // bit 4 (1 << 4) = send_messages.
    const out = permsSummary(1 << 4);
    expect(out).toContain('send messages');
  });

  it('joins multiple bits with " · "', () => {
    // Bits 4 (send) + 6 (create invites).
    const out = permsSummary((1 << 4) | (1 << 6));
    expect(out).toContain('send messages');
    expect(out).toContain('create invites');
    expect(out).toContain(' · ');
  });

  it('lowercases the label before strip-parens', () => {
    // bit 5 = manage_messages, label "Manage messages (delete / pin)"
    const out = permsSummary(1 << 5);
    expect(out).toBe('manage messages');
  });

  it('excludes the admin label even when admin bit not set, but other bits include it', () => {
    // bit 1 = manage_channels only.
    const out = permsSummary(1 << 1);
    expect(out).toBe('manage channels');
    expect(out).not.toContain('admin');
  });
});
