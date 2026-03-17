import { describe, it, expect, beforeEach } from 'vitest';
import { usePresenceStore, type UserPresence } from './presenceStore';

function getState() {
  return usePresenceStore.getState();
}

beforeEach(() => {
  usePresenceStore.setState({
    presences: {},
    myStatus: 'online',
    myCustomStatus: '',
  });
});

const presence: UserPresence = {
  user_id: 'u1',
  status: 'online',
  custom_status: '',
  last_active: new Date().toISOString(),
};

describe('setPresences / updatePresence', () => {
  it('setPresences sets all presences for a team', () => {
    getState().setPresences('t1', { u1: presence });
    expect(getState().presences['t1']['u1'].status).toBe('online');
  });

  it('updatePresence upserts a single presence', () => {
    getState().updatePresence('t1', presence);
    expect(getState().presences['t1']['u1']).toEqual(presence);

    const updated = { ...presence, status: 'idle' as const };
    getState().updatePresence('t1', updated);
    expect(getState().presences['t1']['u1'].status).toBe('idle');
  });
});

describe('getPresence', () => {
  it('returns presence for existing user', () => {
    getState().setPresences('t1', { u1: presence });
    expect(getState().getPresence('t1', 'u1')).toEqual(presence);
  });

  it('returns undefined for non-existent user', () => {
    expect(getState().getPresence('t1', 'unknown')).toBeUndefined();
  });
});

describe('my status', () => {
  it('setMyStatus', () => {
    getState().setMyStatus('dnd');
    expect(getState().myStatus).toBe('dnd');
  });

  it('setMyCustomStatus', () => {
    getState().setMyCustomStatus('In a meeting');
    expect(getState().myCustomStatus).toBe('In a meeting');
  });
});
