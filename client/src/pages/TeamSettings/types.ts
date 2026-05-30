import { useTeamStore } from '../../stores/teamStore';

export type Tab =
  | 'overview'
  | 'roles'
  | 'members'
  | 'invites'
  | 'integrations'
  | 'moderation'
  | 'audit-log'
  | 'bans'
  | 'federation'
  | 'delete-server';

// Canonical permission table — bits and order MUST match
// server-rs/src/db/models.rs (PERM_*). The previous order had
// manageRoles / manageMembers swapped and listed four bits the server
// doesn't know about (voiceConnect, voiceSpeak, uploadFiles,
// createThreads, mentionEveryone), so saving them via PATCH /roles
// either no-op'd or persisted the wrong gate. Synced now.
export const PERMISSION_FLAGS = [
  { bit: 0x001, label: 'permissions.admin' },           // PERM_ADMIN
  { bit: 0x002, label: 'permissions.manageChannels' },  // PERM_MANAGE_CHANNELS
  { bit: 0x004, label: 'permissions.manageMembers' },   // PERM_MANAGE_MEMBERS
  { bit: 0x008, label: 'permissions.manageRoles' },     // PERM_MANAGE_ROLES
  { bit: 0x010, label: 'permissions.sendMessages' },    // PERM_SEND_MESSAGES
  { bit: 0x020, label: 'permissions.manageMessages' },  // PERM_MANAGE_MESSAGES
  { bit: 0x040, label: 'permissions.createInvites' },   // PERM_CREATE_INVITES
  { bit: 0x080, label: 'permissions.manageTeam' },      // PERM_MANAGE_TEAM
  { bit: 0x100, label: 'permissions.bypassSlowMode' },  // PERM_BYPASS_SLOW_MODE
  { bit: 0x200, label: 'permissions.muteVoice' },        // PERM_MUTE_VOICE
];

export interface Invite {
  id: string;
  token: string;
  created_by: string;
  uses: number;
  max_uses: number | null;
  expires_at: string | null;
}

export type Team = ReturnType<typeof useTeamStore.getState>['teams'] extends Map<string, infer T>
  ? T
  : never;
