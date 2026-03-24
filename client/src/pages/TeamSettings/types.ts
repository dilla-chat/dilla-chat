import { useTeamStore } from '../../stores/teamStore';

export type Tab =
  | 'overview'
  | 'roles'
  | 'members'
  | 'invites'
  | 'moderation'
  | 'audit-log'
  | 'bans'
  | 'federation'
  | 'delete-server';

export const PERMISSION_FLAGS = [
  { bit: 0x1, label: 'permissions.admin' },
  { bit: 0x2, label: 'permissions.manageChannels' },
  { bit: 0x4, label: 'permissions.manageRoles' },
  { bit: 0x8, label: 'permissions.manageMembers' },
  { bit: 0x10, label: 'permissions.createInvites' },
  { bit: 0x20, label: 'permissions.sendMessages' },
  { bit: 0x40, label: 'permissions.manageMessages' },
  { bit: 0x80, label: 'permissions.voiceConnect' },
  { bit: 0x100, label: 'permissions.voiceSpeak' },
  { bit: 0x200, label: 'permissions.uploadFiles' },
  { bit: 0x400, label: 'permissions.createThreads' },
  { bit: 0x800, label: 'permissions.mentionEveryone' },
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
