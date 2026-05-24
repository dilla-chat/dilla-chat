import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useShellData, initialsOf } from './useShellData';
import { useTeamStore } from '../stores/teamStore';
import { useAuthStore } from '../stores/authStore';
import { usePresenceStore } from '../stores/presenceStore';
import { useMessageStore } from '../stores/messageStore';
import { useDMStore } from '../stores/dmStore';
import { usePollStore } from '../stores/pollStore';
import { useBlockStore } from '../stores/blockStore';
import { useThreadStore } from '../stores/threadStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useUnreadStore } from '../stores/unreadStore';

vi.mock('../services/api', () => ({
  api: { getAttachmentUrl: (teamId: string, id: string) => `/api/v1/teams/${teamId}/attachments/${id}` },
}));

function resetStores() {
  useTeamStore.setState({ teams: new Map(), channels: new Map(), members: new Map(), activeTeamId: null, activeChannelId: null } as never);
  useAuthStore.setState({ teams: new Map() } as never);
  usePresenceStore.setState({ presences: {} } as never);
  useMessageStore.setState({ messages: new Map() } as never);
  useDMStore.setState({ dmChannels: {}, dmMessages: {} } as never);
  usePollStore.setState({ polls: new Map() } as never);
  useBlockStore.setState({ blocked: new Set() } as never);
  useThreadStore.setState({ threads: {}, threadMessages: {} } as never);
  useVoiceStore.setState({ voiceOccupants: {} } as never);
  useUnreadStore.setState({ counts: {} } as never);
}

describe('initialsOf', () => {
  it('two-word names take the first letter of each', () => {
    expect(initialsOf('Alice Anderson')).toBe('AA');
    expect(initialsOf('jonas thim')).toBe('JT');
  });

  it('single-word names take the first two letters', () => {
    expect(initialsOf('alice')).toBe('AL');
    expect(initialsOf('Bo')).toBe('BO');
  });

  it('three+ word names still take just the first two words', () => {
    expect(initialsOf('John Paul Smith')).toBe('JP');
  });

  it('uppercases the result regardless of input case', () => {
    expect(initialsOf('xander')).toBe('XA');
    expect(initialsOf('foo bar')).toBe('FB');
  });

  it('handles extra whitespace', () => {
    expect(initialsOf('  alice   anderson  ')).toBe('AA');
  });

  it('empty input returns empty string', () => {
    expect(initialsOf('')).toBe('');
  });
});

describe('useShellData', () => {
  beforeEach(() => {
    resetStores();
  });

  it('returns EMPTY_DATA shape when no active team', () => {
    const { result } = renderHook(() => useShellData());
    expect(result.current.SERVERS).toHaveLength(1);
    expect(result.current.SERVERS[0].id).toBe('');
    expect(result.current.CHANNELS).toEqual([]);
    expect(result.current.MEMBERS).toEqual([]);
    expect(result.current.byId).toEqual({});
    expect(result.current.MESSAGES).toEqual({});
    expect(result.current.DMS).toEqual([]);
    expect(result.current.DM_MESSAGES).toEqual({});
    expect(result.current.THREAD_REPLIES).toEqual({});
    expect(result.current.currentUserId).toBeNull();
  });

  it('returns EMPTY_DATA when teams.size is 0 even with activeTeamId set', () => {
    useTeamStore.setState({ activeTeamId: 't1' } as never);
    const { result } = renderHook(() => useShellData());
    expect(result.current.SERVERS[0].id).toBe('');
  });

  it('maps SERVERS from teams store with node derived from authStore baseUrl', () => {
    useTeamStore.setState({
      activeTeamId: 't1',
      teams: new Map([['t1', { id: 't1', name: 'Acme', description: 'desc' }]]),
      channels: new Map([['t1', []]]),
      members: new Map([['t1', []]]),
    } as never);
    useAuthStore.setState({
      teams: new Map([['t1', { baseUrl: 'https://acme.example.com', user: { id: 'u1' } }]]),
    } as never);
    const { result } = renderHook(() => useShellData());
    expect(result.current.SERVERS).toHaveLength(1);
    expect(result.current.SERVERS[0].id).toBe('t1');
    expect(result.current.SERVERS[0].name).toBe('Acme');
    expect(result.current.SERVERS[0].short).toBe('A');
    expect(result.current.SERVERS[0].node).toBe('acme');
    expect(result.current.SERVERS[0].federated).toBe(false);
  });

  it('SERVERS node falls back to "local" when authStore has no baseUrl', () => {
    useTeamStore.setState({
      activeTeamId: 't1',
      teams: new Map([['t1', { id: 't1', name: 'Bare' }]]),
      channels: new Map([['t1', []]]),
      members: new Map([['t1', []]]),
    } as never);
    const { result } = renderHook(() => useShellData());
    expect(result.current.SERVERS[0].node).toBe('local');
  });

  it('SERVERS short is the uppercase first character of the team name', () => {
    useTeamStore.setState({
      activeTeamId: 't1',
      teams: new Map([['t1', { id: 't1', name: 'zebra' }]]),
      channels: new Map([['t1', []]]),
      members: new Map([['t1', []]]),
    } as never);
    const { result } = renderHook(() => useShellData());
    expect(result.current.SERVERS[0].short).toBe('Z');
  });

  it('CHANNELS includes the encrypted=true flag (Mesh promise)', () => {
    useTeamStore.setState({
      activeTeamId: 't1',
      teams: new Map([['t1', { id: 't1', name: 'T' }]]),
      channels: new Map([['t1', [
        { id: 'ch-1', name: 'general', type: 'text', topic: 'g', category: 'C', groupId: 'g1' },
      ]]]),
      members: new Map([['t1', []]]),
    } as never);
    const { result } = renderHook(() => useShellData());
    expect(result.current.CHANNELS).toHaveLength(1);
    expect(result.current.CHANNELS[0].encrypted).toBe(true);
    expect(result.current.CHANNELS[0].name).toBe('general');
    expect(result.current.CHANNELS[0].groupId).toBe('g1');
  });

  it('CHANNELS preserves unread counts from useUnreadStore', () => {
    useTeamStore.setState({
      activeTeamId: 't1',
      teams: new Map([['t1', { id: 't1', name: 'T' }]]),
      channels: new Map([['t1', [{ id: 'ch-1', name: 'g', type: 'text' }]]]),
      members: new Map([['t1', []]]),
    } as never);
    useUnreadStore.setState({ counts: { 'ch-1': 7 } } as never);
    const { result } = renderHook(() => useShellData());
    expect(result.current.CHANNELS[0].unread).toBe(7);
  });

  it('voice channels carry participants + voicePeers from useVoiceStore', () => {
    useTeamStore.setState({
      activeTeamId: 't1',
      teams: new Map([['t1', { id: 't1', name: 'T' }]]),
      channels: new Map([['t1', [{ id: 'voice-1', name: 'v', type: 'voice' }]]]),
      members: new Map([['t1', []]]),
    } as never);
    useVoiceStore.setState({
      voiceOccupants: {
        'voice-1': [
          { user_id: 'u1', muted: true, deafened: false, speaking: false, screen_sharing: false, webcam_sharing: false },
          { user_id: 'u2', muted: false, deafened: false, speaking: true, screen_sharing: false, webcam_sharing: false },
        ],
      },
    } as never);
    const { result } = renderHook(() => useShellData());
    const ch = result.current.CHANNELS[0];
    expect(ch.participants).toEqual(['u1', 'u2']);
    expect(ch.voicePeers.u1.muted).toBe(true);
    expect(ch.voicePeers.u2.speaking).toBe(true);
  });

  it('MEMBERS map carries computed initials + colour + role from team store', () => {
    useTeamStore.setState({
      activeTeamId: 't1',
      teams: new Map([['t1', { id: 't1', name: 'T' }]]),
      channels: new Map([['t1', []]]),
      members: new Map([['t1', [
        {
          userId: 'u1', username: 'alice', displayName: 'Alice Anderson',
          roles: [
            { id: 'r1', name: 'Admin', color: '#f00', position: 2, isDefault: false },
            { id: 'r2', name: '@everyone', color: '#888', position: 0, isDefault: true },
          ],
          publicKeyHex: '', avatarUrl: '', isAdmin: true,
        },
      ]]]),
    } as never);
    const { result } = renderHook(() => useShellData());
    expect(result.current.MEMBERS).toHaveLength(1);
    const m = result.current.MEMBERS[0];
    expect(m.id).toBe('u1');
    expect(m.initials).toBe('AA');
    expect(m.role).toBe('admin'); // highest non-default role, lowercased
    expect(m.roles).toHaveLength(1); // @everyone excluded
    expect(m.isAdmin).toBe(true);
    expect(result.current.byId.u1).toBe(m);
  });

  it('MEMBERS status falls back to "offline" when no presence', () => {
    useTeamStore.setState({
      activeTeamId: 't1',
      teams: new Map([['t1', { id: 't1', name: 'T' }]]),
      channels: new Map([['t1', []]]),
      members: new Map([['t1', [
        { userId: 'u1', username: 'alice', displayName: 'Alice', roles: [], publicKeyHex: '', avatarUrl: '' },
      ]]]),
    } as never);
    const { result } = renderHook(() => useShellData());
    expect(result.current.MEMBERS[0].status).toBe('offline');
  });

  it('MEMBERS status reflects live presence + custom status', () => {
    useTeamStore.setState({
      activeTeamId: 't1',
      teams: new Map([['t1', { id: 't1', name: 'T' }]]),
      channels: new Map([['t1', []]]),
      members: new Map([['t1', [
        { userId: 'u1', username: 'alice', displayName: 'Alice', roles: [], publicKeyHex: '', avatarUrl: '' },
      ]]]),
    } as never);
    usePresenceStore.setState({
      presences: { t1: { u1: { status: 'idle', custom_status: 'brb' } } },
    } as never);
    const { result } = renderHook(() => useShellData());
    expect(result.current.MEMBERS[0].status).toBe('idle');
    expect(result.current.MEMBERS[0].custom).toBe('brb');
  });

  it('MESSAGES filters soft-deleted + blocked authors', () => {
    useTeamStore.setState({
      activeTeamId: 't1',
      teams: new Map([['t1', { id: 't1', name: 'T' }]]),
      channels: new Map([['t1', [{ id: 'ch-1', name: 'g', type: 'text' }]]]),
      members: new Map([['t1', []]]),
    } as never);
    useBlockStore.setState({ blocked: new Set(['blocked-user']) } as never);
    useMessageStore.setState({
      messages: new Map([['ch-1', [
        { id: 'm1', authorId: 'u1', content: 'hi', createdAt: '2026-01-01T00:00:00Z', deleted: false, type: 'text', editedAt: null, reactions: [] },
        { id: 'm2', authorId: 'u1', content: '', createdAt: '2026-01-01T00:01:00Z', deleted: true, type: 'text', editedAt: null, reactions: [] },
        { id: 'm3', authorId: 'blocked-user', content: 'spam', createdAt: '2026-01-01T00:02:00Z', deleted: false, type: 'text', editedAt: null, reactions: [] },
      ]]]),
    } as never);
    const { result } = renderHook(() => useShellData());
    expect(result.current.MESSAGES['ch-1']).toHaveLength(1);
    expect(result.current.MESSAGES['ch-1'][0].id).toBe('m1');
  });

  it('MESSAGES system message gets kind="system"', () => {
    useTeamStore.setState({
      activeTeamId: 't1',
      teams: new Map([['t1', { id: 't1', name: 'T' }]]),
      channels: new Map([['t1', [{ id: 'ch-1', name: 'g', type: 'text' }]]]),
      members: new Map([['t1', []]]),
    } as never);
    useMessageStore.setState({
      messages: new Map([['ch-1', [
        { id: 'm1', authorId: 'u1', content: 'joined', createdAt: '2026-01-01T00:00:00Z', deleted: false, type: 'system', editedAt: null, reactions: [] },
      ]]]),
    } as never);
    const { result } = renderHook(() => useShellData());
    expect(result.current.MESSAGES['ch-1'][0].kind).toBe('system');
  });

  it('MESSAGES carries reactions mapped to handoff shape with mine flag', () => {
    useTeamStore.setState({
      activeTeamId: 't1',
      teams: new Map([['t1', { id: 't1', name: 'T' }]]),
      channels: new Map([['t1', [{ id: 'ch-1', name: 'g', type: 'text' }]]]),
      members: new Map([['t1', [
        { userId: 'u1', username: 'me', displayName: 'Me', roles: [], publicKeyHex: '', avatarUrl: '' },
      ]]]),
    } as never);
    useAuthStore.setState({
      teams: new Map([['t1', { user: { id: 'u1' } }]]),
    } as never);
    useMessageStore.setState({
      messages: new Map([['ch-1', [
        {
          id: 'm1', authorId: 'u2', content: 'hi', createdAt: '2026-01-01T00:00:00Z',
          deleted: false, type: 'text', editedAt: null,
          reactions: [{ emoji: '🎉', users: ['u1', 'u2'], count: 2 }],
        },
      ]]]),
    } as never);
    const { result } = renderHook(() => useShellData());
    const r = result.current.MESSAGES['ch-1'][0].reactions;
    expect(r).toEqual([{ e: '🎉', n: 2, mine: true }]);
  });

  it('THREAD_REPLIES indexes replies by parent_message_id', () => {
    useTeamStore.setState({
      activeTeamId: 't1',
      teams: new Map([['t1', { id: 't1', name: 'T' }]]),
      channels: new Map([['t1', [{ id: 'ch-1', name: 'g', type: 'text' }]]]),
      members: new Map([['t1', []]]),
    } as never);
    useThreadStore.setState({
      threads: { 'ch-1': [{ id: 'th-1', parent_message_id: 'm0', channel_id: 'ch-1', team_id: 't1', creator_id: 'u', title: '', message_count: 0, last_message_at: null, created_at: '2026-01-01' }] },
      threadMessages: {
        'th-1': [
          { id: 'r1', authorId: 'u1', content: 'reply', createdAt: '2026-01-01T00:01:00Z', deleted: false, type: 'text', editedAt: null, reactions: [] },
        ],
      },
    } as never);
    const { result } = renderHook(() => useShellData());
    expect(result.current.THREAD_REPLIES.m0).toHaveLength(1);
    expect(result.current.THREAD_REPLIES.m0[0].id).toBe('r1');
  });

  it('DMS maps 1:1 channel to {with, preview, unread, at}', () => {
    useTeamStore.setState({
      activeTeamId: 't1',
      teams: new Map([['t1', { id: 't1', name: 'T' }]]),
      channels: new Map([['t1', []]]),
      members: new Map([['t1', []]]),
    } as never);
    useAuthStore.setState({
      teams: new Map([['t1', { user: { id: 'me' } }]]),
    } as never);
    useUnreadStore.setState({ counts: { 'dm-1': 3 } } as never);
    useDMStore.setState({
      dmChannels: {
        t1: [
          {
            id: 'dm-1', is_group: false, members: [
              { user_id: 'me', username: 'me' },
              { user_id: 'u2', username: 'alice' },
            ],
            last_message: { content: 'hi', createdAt: '2026-01-01T00:00:00Z' },
            created_at: '2026-01-01',
          },
        ],
      },
      dmMessages: {},
    } as never);
    const { result } = renderHook(() => useShellData());
    expect(result.current.DMS).toHaveLength(1);
    expect(result.current.DMS[0].with).toBe('u2');
    expect(result.current.DMS[0].preview).toBe('hi');
    expect(result.current.DMS[0].unread).toBe(3);
  });

  it('group DMS get group:true + comma-joined username name', () => {
    useTeamStore.setState({
      activeTeamId: 't1',
      teams: new Map([['t1', { id: 't1', name: 'T' }]]),
      channels: new Map([['t1', []]]),
      members: new Map([['t1', []]]),
    } as never);
    useAuthStore.setState({ teams: new Map([['t1', { user: { id: 'me' } }]]) } as never);
    useDMStore.setState({
      dmChannels: {
        t1: [{
          id: 'dm-g', is_group: true,
          members: [
            { user_id: 'me', username: 'me' },
            { user_id: 'u2', username: 'alice' },
            { user_id: 'u3', username: 'bob' },
          ],
          last_message: { content: 'hi', createdAt: '2026-01-01T00:00:00Z' },
          created_at: '2026-01-01',
        }],
      },
      dmMessages: {},
    } as never);
    const { result } = renderHook(() => useShellData());
    expect(result.current.DMS[0].group).toBe(true);
    expect(result.current.DMS[0].with).toEqual(['u2', 'u3']);
    expect(result.current.DMS[0].name).toBe('alice, bob');
  });

  it('attaches Giphy-style attachments via api.getAttachmentUrl', () => {
    useTeamStore.setState({
      activeTeamId: 't1',
      teams: new Map([['t1', { id: 't1', name: 'T' }]]),
      channels: new Map([['t1', [{ id: 'ch-1', name: 'g', type: 'text' }]]]),
      members: new Map([['t1', []]]),
    } as never);
    useAuthStore.setState({ teams: new Map([['t1', { user: { id: 'me' } }]]) } as never);
    useMessageStore.setState({
      messages: new Map([['ch-1', [
        {
          id: 'm1', authorId: 'u1', content: 'see this',
          createdAt: '2026-01-01T00:00:00Z', deleted: false, type: 'text',
          editedAt: null, reactions: [],
          attachments: [{ id: 'a1', filename: 'cat.gif', content_type: 'image/gif', size: 100 }],
        },
      ]]]),
    } as never);
    const { result } = renderHook(() => useShellData());
    const msg = result.current.MESSAGES['ch-1'][0];
    expect(msg.attachment.kind).toBe('image');
    expect(msg.attachment.src).toBe('/api/v1/teams/t1/attachments/a1');
    expect(msg.attachment.label).toBe('cat.gif');
  });

  it('parses [file:...] tokens out of DM-style message content', () => {
    useTeamStore.setState({
      activeTeamId: 't1',
      teams: new Map([['t1', { id: 't1', name: 'T' }]]),
      channels: new Map([['t1', [{ id: 'ch-1', name: 'g', type: 'text' }]]]),
      members: new Map([['t1', []]]),
    } as never);
    useAuthStore.setState({ teams: new Map([['t1', { user: { id: 'me' } }]]) } as never);
    useMessageStore.setState({
      messages: new Map([['ch-1', [
        // Only a [file:...] token, no trailing caption — the label
        // consumes through end-of-string so IMAGE_EXT matches the .png.
        {
          id: 'm1', authorId: 'u1',
          content: '[file:att-1] photo.png',
          createdAt: '2026-01-01T00:00:00Z', deleted: false, type: 'text',
          editedAt: null, reactions: [],
        },
      ]]]),
    } as never);
    const { result } = renderHook(() => useShellData());
    const msg = result.current.MESSAGES['ch-1'][0];
    expect(msg.attachment).toBeDefined();
    expect(msg.attachment.kind).toBe('image');
    expect(msg.attachment.src).toContain('att-1');
  });

  it('the memo recomputes when activeTeamId changes', () => {
    useTeamStore.setState({
      teams: new Map([
        ['t1', { id: 't1', name: 'One' }],
        ['t2', { id: 't2', name: 'Two' }],
      ]),
      channels: new Map([['t1', []], ['t2', []]]),
      members: new Map([['t1', []], ['t2', []]]),
      activeTeamId: 't1',
    } as never);
    const { result, rerender } = renderHook(() => useShellData());
    expect(result.current.activeServerId).toBe('t1');
    useTeamStore.setState({ activeTeamId: 't2' } as never);
    rerender();
    expect(result.current.activeServerId).toBe('t2');
  });
});
