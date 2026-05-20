// Per-team permission resolver. Reads the current user's roles and OR's
// their permissions bitmasks together; PERM_ADMIN implies everything.
//
// Single source of truth for the client side — components used to check
// `member.isAdmin` directly, which only catered for full-admin gating.
// With this hook a menu can ask "can I PERM_MANAGE_MESSAGES?" and the
// UI shrinks gracefully for moderators who hold some bits but not the
// admin flag.

import { useMemo } from 'react';
import { useTeamStore } from '../stores/teamStore';

// Mirror server-rs/src/db/models.rs. Keep in lockstep.
export const PERM_ADMIN            = 0x001;
export const PERM_MANAGE_CHANNELS  = 0x002;
export const PERM_MANAGE_MEMBERS   = 0x004;
export const PERM_MANAGE_ROLES     = 0x008;
export const PERM_SEND_MESSAGES    = 0x010;
export const PERM_MANAGE_MESSAGES  = 0x020;
export const PERM_CREATE_INVITES   = 0x040;
export const PERM_MANAGE_TEAM      = 0x080;
export const PERM_BYPASS_SLOW_MODE = 0x100;

export interface Permissions {
  /** Raw OR of the user's role permissions bitmasks. */
  bits: number;
  /** True if any role grants PERM_ADMIN — the user can do everything. */
  isAdmin: boolean;
  /** Check a specific bit. Admin always returns true regardless of bit. */
  has: (bit: number) => boolean;
}

/** Resolve `userId`'s permissions in the team. Pass `undefined` userId to
 *  get an "empty / no permissions" result; useful while auth is loading. */
export function resolvePermissions(
  members: Array<{ userId: string; roles: Array<{ permissions: number }> }>,
  userId: string | undefined,
): Permissions {
  const me = userId ? members.find((m) => m.userId === userId) : undefined;
  const bits = me?.roles.reduce((acc, r) => acc | (r.permissions || 0), 0) ?? 0;
  const isAdmin = (bits & PERM_ADMIN) !== 0;
  return {
    bits,
    isAdmin,
    has: (bit: number) => isAdmin || (bits & bit) !== 0,
  };
}

/** React hook variant — subscribes to the team's members so a role change
 *  re-renders consumers. */
export function usePermissions(teamId: string | null, userId: string | undefined): Permissions {
  const members = useTeamStore((s) => (teamId ? s.members.get(teamId) ?? [] : []));
  return useMemo(() => resolvePermissions(members, userId), [members, userId]);
}
