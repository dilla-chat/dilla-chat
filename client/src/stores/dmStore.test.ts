import { describe, it, expect, beforeEach } from 'vitest';
import { useDMStore, type DMChannel } from './dmStore';
import { createMockMessage } from '../test/helpers';

function getState() {
  return useDMStore.getState();
}

beforeEach(() => {
  useDMStore.setState({
    dmChannels: {},
    activeDMId: null,
    dmMessages: {},
    dmTyping: {},
  });
});

const mockDM: DMChannel = {
  id: 'dm-1',
  team_id: 't1',
  is_group: false,
  members: [
    { user_id: 'u1', username: 'alice', display_name: 'Alice' },
    { user_id: 'u2', username: 'bob', display_name: 'Bob' },
  ],
  created_at: new Date().toISOString(),
};

describe('DM channel CRUD', () => {
  it('setDMChannels sets channels for a team', () => {
    getState().setDMChannels('t1', [mockDM]);
    expect(getState().dmChannels['t1']).toHaveLength(1);
  });

  it('addDMChannel prepends and deduplicates', () => {
    getState().addDMChannel('t1', mockDM);
    getState().addDMChannel('t1', mockDM); // duplicate
    expect(getState().dmChannels['t1']).toHaveLength(1);

    const dm2: DMChannel = { ...mockDM, id: 'dm-2' };
    getState().addDMChannel('t1', dm2);
    expect(getState().dmChannels['t1']).toHaveLength(2);
    expect(getState().dmChannels['t1'][0].id).toBe('dm-2'); // prepended
  });

  it('setActiveDM', () => {
    getState().setActiveDM('dm-1');
    expect(getState().activeDMId).toBe('dm-1');
    getState().setActiveDM(null);
    expect(getState().activeDMId).toBeNull();
  });
});

describe('DM message CRUD', () => {
  it('setDMMessages sets messages', () => {
    const msgs = [createMockMessage({ id: 'm1' })];
    getState().setDMMessages('dm-1', msgs);
    expect(getState().dmMessages['dm-1']).toHaveLength(1);
  });

  it('addDMMessage appends with deduplication', () => {
    const msg = createMockMessage({ id: 'm1' });
    getState().addDMMessage('dm-1', msg);
    getState().addDMMessage('dm-1', msg);
    expect(getState().dmMessages['dm-1']).toHaveLength(1);
  });

  it('updateDMMessage replaces matching message', () => {
    const msg = createMockMessage({ id: 'm1', content: 'old' });
    getState().setDMMessages('dm-1', [msg]);
    const updated = { ...msg, content: 'new' };
    getState().updateDMMessage('dm-1', updated);
    expect(getState().dmMessages['dm-1'][0].content).toBe('new');
  });

  it('removeDMMessage marks as deleted', () => {
    const msg = createMockMessage({ id: 'm1', content: 'hello' });
    getState().setDMMessages('dm-1', [msg]);
    getState().removeDMMessage('dm-1', 'm1');
    expect(getState().dmMessages['dm-1'][0].deleted).toBe(true);
    expect(getState().dmMessages['dm-1'][0].content).toBe('');
  });
});

describe('typing state', () => {
  it('setDMTyping sets typing users', () => {
    getState().setDMTyping('dm-1', ['u1', 'u2']);
    expect(getState().dmTyping['dm-1']).toEqual(['u1', 'u2']);
  });
});
