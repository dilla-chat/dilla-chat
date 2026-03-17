import { describe, it, expect, beforeEach } from 'vitest';
import { useTeamStore, type Team, type Channel, type Member, type Role } from './teamStore';

function getState() {
  return useTeamStore.getState();
}

beforeEach(() => {
  useTeamStore.setState({
    teams: new Map(),
    channels: new Map(),
    members: new Map(),
    roles: new Map(),
    activeTeamId: null,
    activeChannelId: null,
  });
});

const mockTeam: Team = {
  id: 't1',
  name: 'Test Team',
  description: 'desc',
  iconUrl: '',
  maxFileSize: 1024,
  allowMemberInvites: true,
};

const mockChannel: Channel = {
  id: 'ch-1',
  teamId: 't1',
  name: 'general',
  topic: '',
  type: 'text',
  position: 0,
  category: 'General',
};

describe('active state', () => {
  it('setActiveTeam', () => {
    getState().setActiveTeam('t1');
    expect(getState().activeTeamId).toBe('t1');
  });

  it('setActiveChannel', () => {
    getState().setActiveChannel('ch-1');
    expect(getState().activeChannelId).toBe('ch-1');
  });
});

describe('setTeam', () => {
  it('adds a team', () => {
    getState().setTeam(mockTeam);
    expect(getState().teams.get('t1')).toEqual(mockTeam);
  });
});

describe('setChannels / setMembers / setRoles', () => {
  it('sets channels for a team', () => {
    getState().setChannels('t1', [mockChannel]);
    expect(getState().channels.get('t1')).toHaveLength(1);
  });

  it('sets members for a team', () => {
    const member: Member = {
      id: 'm1', userId: 'u1', username: 'alice', displayName: 'Alice',
      nickname: '', roles: [], statusType: 'online',
    };
    getState().setMembers('t1', [member]);
    expect(getState().members.get('t1')).toHaveLength(1);
  });

  it('sets roles for a team', () => {
    const role: Role = { id: 'r1', name: 'Admin', color: '#fff', position: 0, permissions: 0, isDefault: false };
    getState().setRoles('t1', [role]);
    expect(getState().roles.get('t1')).toHaveLength(1);
  });
});

describe('addChannel / removeChannel / updateChannel', () => {
  it('addChannel appends', () => {
    getState().addChannel('t1', mockChannel);
    expect(getState().channels.get('t1')).toHaveLength(1);
  });

  it('removeChannel filters by id', () => {
    getState().addChannel('t1', mockChannel);
    getState().removeChannel('t1', 'ch-1');
    expect(getState().channels.get('t1')).toHaveLength(0);
  });

  it('updateChannel replaces matching channel', () => {
    getState().addChannel('t1', mockChannel);
    const updated = { ...mockChannel, name: 'renamed' };
    getState().updateChannel('t1', updated);
    expect(getState().channels.get('t1')![0].name).toBe('renamed');
  });
});
