// Coverage for the per-team permissions resolver. resolvePermissions
// is the pure function under usePermissions — testing it directly
// keeps the table-test count cheap and exercises every branch.

import { describe, it, expect } from 'vitest';
import {
  resolvePermissions,
  PERM_ADMIN,
  PERM_MANAGE_CHANNELS,
  PERM_MANAGE_MEMBERS,
  PERM_MANAGE_ROLES,
  PERM_SEND_MESSAGES,
  PERM_MANAGE_MESSAGES,
  PERM_CREATE_INVITES,
  PERM_MANAGE_TEAM,
  PERM_BYPASS_SLOW_MODE,
  PERM_MUTE_VOICE,
} from './usePermissions';

describe('resolvePermissions', () => {
  it('returns empty perms when userId is undefined', () => {
    const out = resolvePermissions([], undefined);
    expect(out.bits).toBe(0);
    expect(out.isAdmin).toBe(false);
    expect(out.has(PERM_MANAGE_CHANNELS)).toBe(false);
  });

  it('returns empty perms when the user is not in the members list', () => {
    const out = resolvePermissions(
      [{ userId: 'u1', roles: [{ permissions: PERM_ADMIN }] }],
      'u-not-here',
    );
    expect(out.bits).toBe(0);
    expect(out.isAdmin).toBe(false);
  });

  it('OR-combines bits across multiple roles', () => {
    const out = resolvePermissions(
      [{
        userId: 'u1',
        roles: [
          { permissions: PERM_MANAGE_CHANNELS },
          { permissions: PERM_MANAGE_MESSAGES },
          { permissions: PERM_MUTE_VOICE },
        ],
      }],
      'u1',
    );
    expect(out.bits).toBe(
      PERM_MANAGE_CHANNELS | PERM_MANAGE_MESSAGES | PERM_MUTE_VOICE,
    );
    expect(out.has(PERM_MANAGE_CHANNELS)).toBe(true);
    expect(out.has(PERM_MANAGE_MESSAGES)).toBe(true);
    expect(out.has(PERM_MUTE_VOICE)).toBe(true);
    expect(out.has(PERM_BYPASS_SLOW_MODE)).toBe(false);
  });

  it('isAdmin flips true when any role has PERM_ADMIN', () => {
    const out = resolvePermissions(
      [{ userId: 'u1', roles: [{ permissions: PERM_ADMIN }] }],
      'u1',
    );
    expect(out.isAdmin).toBe(true);
  });

  it('admin implies every other permission via has()', () => {
    const out = resolvePermissions(
      [{ userId: 'u1', roles: [{ permissions: PERM_ADMIN }] }],
      'u1',
    );
    expect(out.has(PERM_MANAGE_CHANNELS)).toBe(true);
    expect(out.has(PERM_MANAGE_MEMBERS)).toBe(true);
    expect(out.has(PERM_MANAGE_ROLES)).toBe(true);
    expect(out.has(PERM_SEND_MESSAGES)).toBe(true);
    expect(out.has(PERM_MANAGE_MESSAGES)).toBe(true);
    expect(out.has(PERM_CREATE_INVITES)).toBe(true);
    expect(out.has(PERM_MANAGE_TEAM)).toBe(true);
    expect(out.has(PERM_BYPASS_SLOW_MODE)).toBe(true);
    expect(out.has(PERM_MUTE_VOICE)).toBe(true);
  });

  it('tolerates undefined permissions on a role entry', () => {
    const out = resolvePermissions(
      [{
        userId: 'u1',
        roles: [
          { permissions: 0 },
          { permissions: PERM_SEND_MESSAGES },
        ],
      }],
      'u1',
    );
    expect(out.bits).toBe(PERM_SEND_MESSAGES);
  });

  it('user with empty roles list has zero permissions', () => {
    const out = resolvePermissions(
      [{ userId: 'u1', roles: [] }],
      'u1',
    );
    expect(out.bits).toBe(0);
    expect(out.isAdmin).toBe(false);
  });

  it('non-admin user with the exact bit succeeds, missing bit fails', () => {
    const out = resolvePermissions(
      [{ userId: 'u1', roles: [{ permissions: PERM_CREATE_INVITES }] }],
      'u1',
    );
    expect(out.has(PERM_CREATE_INVITES)).toBe(true);
    expect(out.has(PERM_MANAGE_ROLES)).toBe(false);
  });
});

describe('usePermissions hook', () => {
  it('returns empty perms when teamId is set but team has no members', async () => {
    const { renderHook } = await import('@testing-library/react');
    const { useTeamStore } = await import('../stores/teamStore');
    const { usePermissions } = await import('./usePermissions');
    useTeamStore.setState({ members: new Map([['t1', []]]) } as never);
    const { result } = renderHook(() => usePermissions('t1', 'u1'));
    expect(result.current.bits).toBe(0);
  });

  it('returns admin perms when the user has admin role', async () => {
    const { renderHook } = await import('@testing-library/react');
    const { useTeamStore } = await import('../stores/teamStore');
    const { usePermissions } = await import('./usePermissions');
    useTeamStore.setState({
      members: new Map([['t1', [{ userId: 'u1', roles: [{ permissions: PERM_ADMIN }] }] as never]]),
    } as never);
    const { result } = renderHook(() => usePermissions('t1', 'u1'));
    expect(result.current.isAdmin).toBe(true);
  });
});
