import { create } from 'zustand';

export interface Team {
  id: string;
  name: string;
  description: string;
  iconUrl: string;
  maxFileSize: number;
  allowMemberInvites: boolean;
}

export interface Channel {
  id: string;
  teamId: string;
  name: string;
  topic: string;
  type: 'text' | 'voice';
  position: number;
  category: string;
}

export interface Member {
  id: string;
  userId: string;
  username: string;
  displayName: string;
  nickname: string;
  roles: Role[];
  statusType: string;
}

export interface Role {
  id: string;
  name: string;
  color: string;
  position: number;
  permissions: number;
  isDefault: boolean;
}

interface TeamState {
  teams: Map<string, Team>;
  channels: Map<string, Channel[]>;
  members: Map<string, Member[]>;
  roles: Map<string, Role[]>;
  activeTeamId: string | null;
  activeChannelId: string | null;

  setActiveTeam: (teamId: string) => void;
  setActiveChannel: (channelId: string) => void;
  setTeam: (team: Team) => void;
  setChannels: (teamId: string, channels: Channel[]) => void;
  setMembers: (teamId: string, members: Member[]) => void;
  setRoles: (teamId: string, roles: Role[]) => void;
  addChannel: (teamId: string, channel: Channel) => void;
  removeChannel: (teamId: string, channelId: string) => void;
  updateChannel: (teamId: string, channel: Channel) => void;
}

export const useTeamStore = create<TeamState>((set) => ({
  teams: new Map(),
  channels: new Map(),
  members: new Map(),
  roles: new Map(),
  activeTeamId: null,
  activeChannelId: null,

  setActiveTeam: (teamId: string) => set({ activeTeamId: teamId }),

  setActiveChannel: (channelId: string) => set({ activeChannelId: channelId }),

  setTeam: (team: Team) =>
    set((state) => {
      const teams = new Map(state.teams);
      teams.set(team.id, team);
      return { teams };
    }),

  setChannels: (teamId: string, channels: Channel[]) =>
    set((state) => {
      const map = new Map(state.channels);
      map.set(teamId, channels);
      return { channels: map };
    }),

  setMembers: (teamId: string, members: Member[]) =>
    set((state) => {
      const map = new Map(state.members);
      map.set(teamId, members);
      return { members: map };
    }),

  setRoles: (teamId: string, roles: Role[]) =>
    set((state) => {
      const map = new Map(state.roles);
      map.set(teamId, roles);
      return { roles: map };
    }),

  addChannel: (teamId: string, channel: Channel) =>
    set((state) => {
      const map = new Map(state.channels);
      const existing = map.get(teamId) ?? [];
      map.set(teamId, [...existing, channel]);
      return { channels: map };
    }),

  removeChannel: (teamId: string, channelId: string) =>
    set((state) => {
      const map = new Map(state.channels);
      const existing = map.get(teamId) ?? [];
      map.set(
        teamId,
        existing.filter((c) => c.id !== channelId),
      );
      return { channels: map };
    }),

  updateChannel: (teamId: string, channel: Channel) =>
    set((state) => {
      const map = new Map(state.channels);
      const existing = map.get(teamId) ?? [];
      map.set(
        teamId,
        existing.map((c) => (c.id === channel.id ? channel : c)),
      );
      return { channels: map };
    }),
}));
