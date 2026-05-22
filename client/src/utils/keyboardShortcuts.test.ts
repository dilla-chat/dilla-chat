import { describe, it, expect } from 'vitest';
import { shortcuts, groupedShortcuts } from './keyboardShortcuts';

describe('shortcuts catalog', () => {
  it('exposes every navigation + voice shortcut', () => {
    expect(shortcuts.length).toBeGreaterThanOrEqual(6);
    const navGroup = shortcuts.filter((s) => s.group === 'shortcuts.group.navigation');
    const voiceGroup = shortcuts.filter((s) => s.group === 'shortcuts.group.voice');
    expect(navGroup.length).toBeGreaterThanOrEqual(4);
    expect(voiceGroup.length).toBeGreaterThanOrEqual(2);
  });

  it('every shortcut has key + action + group', () => {
    for (const s of shortcuts) {
      expect(s.key).toBeTypeOf('string');
      expect(s.key.length).toBeGreaterThan(0);
      expect(s.action).toBeTypeOf('string');
      expect(s.group).toBeTypeOf('string');
    }
  });
});

describe('groupedShortcuts', () => {
  it('groups by .group field', () => {
    const groups = groupedShortcuts();
    expect(groups.some((g) => g.group === 'shortcuts.group.navigation')).toBe(true);
    expect(groups.some((g) => g.group === 'shortcuts.group.voice')).toBe(true);
  });

  it('every entry in the flat list lands in exactly one group', () => {
    const groups = groupedShortcuts();
    const flat = groups.flatMap((g) => g.shortcuts);
    expect(flat.length).toBe(shortcuts.length);
    // No duplicate keys across groups (each shortcut belongs to one bucket).
    const keys = flat.map((s) => `${s.group}|${s.key}|${s.action}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('groups preserve relative order from the source list', () => {
    const navGroup = groupedShortcuts().find(
      (g) => g.group === 'shortcuts.group.navigation',
    );
    expect(navGroup).toBeDefined();
    const sourceNav = shortcuts.filter((s) => s.group === 'shortcuts.group.navigation');
    expect(navGroup!.shortcuts.map((s) => s.action)).toEqual(
      sourceNav.map((s) => s.action),
    );
  });
});
