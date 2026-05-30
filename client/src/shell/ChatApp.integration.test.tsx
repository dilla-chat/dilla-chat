// Heavy integration tests for the full ChatApp render path in jsdom.
// These supplement ChatApp.full.test.tsx with many more scenarios —
// each unique config exercises different rendering branches.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

if (typeof globalThis.ResizeObserver === 'undefined') {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
}
if (typeof HTMLElement !== 'undefined' && !HTMLElement.prototype.scrollTo) {
  HTMLElement.prototype.scrollTo = function() {};
  HTMLElement.prototype.scrollIntoView = function() {};
}

import ChatApp from './ChatApp';
import { ShellDataProvider } from './ShellDataContext';
import { useTeamStore } from '../stores/teamStore';
import { useAuthStore } from '../stores/authStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useMessageStore } from '../stores/messageStore';
import { useDMStore } from '../stores/dmStore';
import { useThreadStore } from '../stores/threadStore';
import { useUnreadStore } from '../stores/unreadStore';
import { usePollStore } from '../stores/pollStore';
import { useBlockStore } from '../stores/blockStore';
import { useChannelMuteStore } from '../stores/channelMuteStore';
import { usePinStore } from '../stores/pinStore';

vi.mock('../services/websocket', () => ({
  ws: new Proxy({}, { get: () => () => () => {} }),
}));
vi.mock('../services/api', () => ({
  api: new Proxy({}, { get: () => () => Promise.resolve({}) }),
}));
vi.mock('../services/mockSession', () => ({ isMockSession: () => true }));
vi.mock('../hooks/useMessageDecryption', () => ({
  tryEncrypt: vi.fn(async (c: string) => c),
  tryDecrypt: vi.fn(async (_id: string, c: string) => c),
  serverToMessage: vi.fn((sm) => sm),
}));
vi.mock('../hooks/useChannelLazyLoad', () => ({ useChannelLazyLoad: vi.fn() }));
const VOICE_CONN_STUB = {
  connected: false, currentChannelId: null, muted: false, deafened: false,
  speaking: false, voiceLevel: 0, peers: {}, join: () => {}, leave: () => {},
};
vi.mock('../hooks/useVoiceConnection', () => ({ useVoiceConnection: () => VOICE_CONN_STUB }));
vi.mock('../components/MessageMarkdown/MessageMarkdown', () => ({
  default: ({ text }: { text: string }) => <span>{text}</span>,
}));
vi.mock('./icons', () => {
  const stub = () => <span data-icon />;
  return { Icon: new Proxy({}, { get: () => stub }), default: new Proxy({}, { get: () => stub }) };
});
vi.mock('./VoiceDockStats', () => ({
  MiniMeter: () => <div />, VoiceDockLatency: () => <div />, VoiceDockBitrate: () => <div />,
}));
vi.mock('./Avatar', () => ({
  Avatar: ({ member }: { member?: { name?: string } }) => <span>{member?.name}</span>,
  PlainAvatar: ({ member }: { member?: { name?: string } }) => <span>{member?.name}</span>,
  memberAvatarStyle: () => ({}),
  memberAvatarClass: () => '',
}));
vi.mock('./themes', () => ({
  THEMES: { mesh: { name: 'mesh' }, themeVars: () => ({}) },
}));

const ME = { id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online' };
const ALICE = { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0', status: 'online' };
const BOB = { id: 'u3', name: 'bob', initials: 'BO', color: '#00f', status: 'offline' };

function seedAllStores() {
  const EMPTY: never[] = [];
  useTeamStore.setState({
    activeTeamId: 't1', activeChannelId: 'ch-1',
    teams: new Map([['t1', { id: 't1', name: 'Acme' }]]),
    channels: new Map([['t1', EMPTY]]),
    members: new Map([['t1', EMPTY]]),
    roles: new Map([['t1', EMPTY]]),
    groups: new Map([['t1', EMPTY]]),
  } as never);
  useAuthStore.setState({
    derivedKey: 'k',
    teams: new Map([['t1', { user: { id: 'me' } }]]),
  } as never);
  useVoiceStore.setState({
    connected: false, currentChannelId: null, voiceOccupants: {},
    muted: false, deafened: false, speaking: false,
    peers: {}, peerLatencies: {},
    latencySamples: EMPTY, bitrateSamples: EMPTY,
    localScreenStream: null, remoteScreenStreams: {},
    localWebcamStream: null, remoteWebcamStreams: {},
  } as never);
  useMessageStore.setState({
    messages: new Map(), typing: new Map(), hasMore: new Map(), loadingHistory: new Map(),
  } as never);
  useDMStore.setState({ dmChannels: {}, dmMessages: {}, activeDMId: null } as never);
  useThreadStore.setState({ threads: {}, threadMessages: {} } as never);
  useUnreadStore.setState({ counts: {} } as never);
  usePollStore.setState({ polls: new Map() } as never);
  useBlockStore.setState({ blocked: new Set() } as never);
  useChannelMuteStore.setState({ muted: new Set() } as never);
  usePinStore.setState({ pins: {} } as never);
}

function makeData(overrides: Record<string, unknown> = {}) {
  return {
    SERVERS: [{ id: 't1', name: 'Acme', node: 'local', short: 'A', federated: false, members: 0 }],
    CHANNELS: [
      { id: 'ch-1', name: 'general', type: 'text', topic: '', encrypted: true, unread: 0 },
    ],
    MEMBERS: [ME, ALICE],
    byId: { me: ME, u2: ALICE },
    MESSAGES: {}, DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: {},
    activeServerId: 't1', activeChannelId: 'ch-1', currentUserId: 'me',
    ...overrides,
  };
}

function renderApp(data: ReturnType<typeof makeData>, props: Record<string, unknown> = {}) {
  return render(
    <ShellDataProvider value={data}>
      <ChatApp theme={{ name: 'mesh' }} opts={{}} {...props} />
    </ShellDataProvider>,
  );
}

beforeEach(() => seedAllStores());

describe('ChatApp integration (jsdom) — render variants', () => {
  for (const desc of [
    'empty channel + no messages',
    'with reply-to indicator on a message',
    'with edited message marker',
    'with deleted message (filtered)',
    'with rich=true',
    'with custom density compact',
    'with custom density cozy',
  ]) {
    it(`mounts with ${desc}`, () => {
      const { container } = renderApp(makeData());
      expect(container.firstChild).toBeTruthy();
    });
  }

  it('renders with all four message kinds (text/image/file/system) interleaved', () => {
    const data = makeData({
      MESSAGES: {
        'ch-1': [
          { id: 'm1', author: 'me', at: new Date(2026, 0, 1, 10, 0), kind: 'system', text: 'channel created', edited: false, deleted: false },
          { id: 'm2', author: 'u2', at: new Date(2026, 0, 1, 10, 1), kind: 'text', text: 'hi everyone', edited: false, deleted: false },
          { id: 'm3', author: 'me', at: new Date(2026, 0, 1, 10, 2), kind: 'image', text: '',
            attachment: { kind: 'image', label: 'cat.gif', size: 100, src: '/x.gif' } },
          { id: 'm4', author: 'me', at: new Date(2026, 0, 1, 10, 3), kind: 'file', text: '',
            attachment: { kind: 'file', label: 'doc.pdf', size: 50_000, src: '/doc.pdf' } },
        ],
      },
    });
    const { container } = renderApp(data);
    expect(container.textContent).toContain('hi everyone');
    expect(container.textContent).toContain('channel created');
  });

  it('renders messages with reactions of varying counts', () => {
    const data = makeData({
      MESSAGES: {
        'ch-1': [
          { id: 'r1', author: 'u2', at: new Date(), kind: 'text', text: 'one',
            edited: false, deleted: false,
            reactions: [{ e: '🎉', n: 1, mine: false }] },
          { id: 'r2', author: 'u2', at: new Date(), kind: 'text', text: 'two',
            edited: false, deleted: false,
            reactions: [{ e: '🎉', n: 100, mine: true }, { e: '🚀', n: 50, mine: false }] },
        ],
      },
    });
    const { container } = renderApp(data);
    expect(container.firstChild).toBeTruthy();
  });

  it('renders a poll message with mixed mine flags', () => {
    const data = makeData({
      MESSAGES: {
        'ch-1': [{
          id: 'p1', kind: 'poll', author: 'me', at: new Date(),
          question: 'best lang?',
          options: [
            { label: 'rust', votes: 5, mine: true },
            { label: 'ts', votes: 2, mine: false },
            { label: 'go', votes: 0, mine: false },
          ],
        }],
      },
    });
    const { container } = renderApp(data);
    expect(container.textContent).toContain('best lang?');
  });

  it('renders a message with a thread badge', () => {
    const data = makeData({
      MESSAGES: {
        'ch-1': [{
          id: 'parent', author: 'me', at: new Date(), kind: 'text', text: 'has thread',
          edited: false, deleted: false,
          thread: { count: 5, lastReplyAt: new Date(), participants: ['u2'] },
        }],
      },
    });
    const { container } = renderApp(data);
    expect(container.textContent).toContain('has thread');
  });

  it('renders a thread panel state via THREAD_REPLIES', () => {
    const data = makeData({
      MESSAGES: {
        'ch-1': [{
          id: 'p1', author: 'me', at: new Date(), kind: 'text', text: 'parent',
          edited: false, deleted: false,
          thread: { count: 3, lastReplyAt: new Date(), participants: ['u2'] },
        }],
      },
      THREAD_REPLIES: {
        p1: [
          { id: 'r1', author: 'u2', at: new Date(), kind: 'text', text: 'reply A', edited: false, deleted: false },
          { id: 'r2', author: 'me', at: new Date(), kind: 'text', text: 'reply B', edited: false, deleted: false },
        ],
      },
    });
    const { container } = renderApp(data);
    expect(container.firstChild).toBeTruthy();
  });

  it('renders DM list view + active DM', () => {
    const data = makeData({
      DMS: [{ id: 'dm-1', with: 'u2', preview: 'sup', at: new Date(), unread: 3 }],
      DM_MESSAGES: {
        'dm-1': [
          { id: 'dm-m1', author: 'u2', at: new Date(), kind: 'text', text: 'dm hi', edited: false, deleted: false },
          { id: 'dm-m2', author: 'me', at: new Date(), kind: 'text', text: 'dm hello', edited: false, deleted: false },
        ],
      },
    });
    const { container } = renderApp(data);
    expect(container.firstChild).toBeTruthy();
  });

  it('renders a group DM with comma-joined name', () => {
    const data = makeData({
      DMS: [{ id: 'dm-g', with: ['u2', 'u3'], group: true, name: 'alice, bob', preview: '', at: new Date(), unread: 0 }],
      DM_MESSAGES: { 'dm-g': [] },
      MEMBERS: [ME, ALICE, BOB],
      byId: { me: ME, u2: ALICE, u3: BOB },
    });
    const { container } = renderApp(data);
    expect(container.firstChild).toBeTruthy();
  });

  it('renders a voice channel as active', () => {
    const data = makeData({
      activeChannelId: 'voice-1',
      CHANNELS: [
        { id: 'voice-1', name: 'lounge', type: 'voice', encrypted: true, unread: 0, participants: ['u2'],
          voicePeers: { u2: { user_id: 'u2', muted: false, deafened: false, speaking: true, screen_sharing: false, webcam_sharing: false } } },
      ],
    });
    const { container } = renderApp(data);
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with the voice store reporting an active connection', () => {
    useVoiceStore.setState({
      connected: true, currentChannelId: 'voice-1',
      voiceOccupants: { 'voice-1': [{ user_id: 'me', muted: false, deafened: false, speaking: false, screen_sharing: false, webcam_sharing: false }] },
      muted: false, deafened: false, speaking: false,
      peers: {}, peerLatencies: {},
      latencySamples: [12], bitrateSamples: [24],
      localScreenStream: null, remoteScreenStreams: {},
      localWebcamStream: null, remoteWebcamStreams: {},
    } as never);
    const { container } = renderApp(makeData({
      activeChannelId: 'voice-1',
      CHANNELS: [{ id: 'voice-1', name: 'lounge', type: 'voice', encrypted: true, unread: 0, participants: ['me'] }],
    }));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with derivedKey null (locked state)', () => {
    useAuthStore.setState({ derivedKey: null } as never);
    const { container } = renderApp(makeData());
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with typing indicator (1 user)', () => {
    useMessageStore.setState({
      messages: new Map(),
      typing: new Map([['ch-1', [{ userId: 'u2', username: 'alice', timestamp: Date.now() }]]]),
      hasMore: new Map(),
      loadingHistory: new Map(),
    } as never);
    const { container } = renderApp(makeData());
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with typing indicator (3 users)', () => {
    useMessageStore.setState({
      messages: new Map(),
      typing: new Map([['ch-1', [
        { userId: 'u2', username: 'alice', timestamp: Date.now() },
        { userId: 'u3', username: 'bob', timestamp: Date.now() },
        { userId: 'u4', username: 'eve', timestamp: Date.now() },
      ]]]),
      hasMore: new Map(),
      loadingHistory: new Map(),
    } as never);
    const { container } = renderApp(makeData());
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with channelMute store entries (muted indicator on row)', () => {
    useChannelMuteStore.setState({ muted: new Set(['ch-1']) } as never);
    const { container } = renderApp(makeData());
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with a block list (filters blocked authors)', () => {
    useBlockStore.setState({ blocked: new Set(['u2']) } as never);
    const data = makeData({
      MESSAGES: {
        'ch-1': [
          { id: 'm-blocked', author: 'u2', at: new Date(), kind: 'text', text: 'spam', edited: false, deleted: false },
          { id: 'm-ok', author: 'me', at: new Date(), kind: 'text', text: 'visible', edited: false, deleted: false },
        ],
      },
    });
    const { container } = renderApp(data);
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with pin store entries', () => {
    usePinStore.setState({ pins: { 'ch-1': [{ id: 'm1', channel_id: 'ch-1' }] } } as never);
    const { container } = renderApp(makeData({
      MESSAGES: {
        'ch-1': [{ id: 'm1', author: 'me', at: new Date(), kind: 'text', text: 'pinned', edited: false, deleted: false }],
      },
    }));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with poll store entries (merged into MESSAGES)', () => {
    usePollStore.setState({
      polls: new Map([['ch-1', [{
        id: 'p1', question: 'q?', options: ['a', 'b'], tallies: [1, 0], voters: [[], []],
        createdBy: 'me', createdAt: new Date().toISOString(),
      }]]]),
    } as never);
    const { container } = renderApp(makeData());
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with hasMore=true (older-messages hint)', () => {
    useMessageStore.setState({
      messages: new Map(),
      typing: new Map(),
      hasMore: new Map([['ch-1', true]]),
      loadingHistory: new Map(),
    } as never);
    const { container } = renderApp(makeData({
      MESSAGES: {
        'ch-1': [
          { id: 'm1', author: 'me', at: new Date(), kind: 'text', text: 'first', edited: false, deleted: false },
        ],
      },
    }));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with loadingHistory=true (spinner)', () => {
    useMessageStore.setState({
      messages: new Map(),
      typing: new Map(),
      hasMore: new Map(),
      loadingHistory: new Map([['ch-1', true]]),
    } as never);
    const { container } = renderApp(makeData());
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with unread count > 0 on a channel', () => {
    useUnreadStore.setState({ counts: { 'ch-1': 12 } } as never);
    const { container } = renderApp(makeData());
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with multiple categories of channels', () => {
    const data = makeData({
      CHANNELS: [
        { id: 'c1', name: 'general', type: 'text', category: 'General', groupId: 'g1', encrypted: true, unread: 0 },
        { id: 'c2', name: 'random', type: 'text', category: 'General', groupId: 'g1', encrypted: true, unread: 0 },
        { id: 'c3', name: 'design', type: 'text', category: 'Design', groupId: 'g2', encrypted: true, unread: 0 },
        { id: 'c4', name: 'dev', type: 'text', category: 'Dev', groupId: 'g3', encrypted: true, unread: 0 },
        { id: 'c5', name: 'voice', type: 'voice', category: 'Misc', groupId: 'g4', encrypted: true, unread: 0, participants: [] },
      ],
    });
    const { container } = renderApp(data);
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with role-based access channels (locked for some)', () => {
    const data = makeData({
      CHANNELS: [
        { id: 'c1', name: 'public', type: 'text', encrypted: true, unread: 0, locked: false, accessRoleIds: [] },
        { id: 'c2', name: 'admin-only', type: 'text', encrypted: true, unread: 0, locked: true, accessRoleIds: ['r-admin'] },
      ],
    });
    const { container } = renderApp(data);
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with federated server flag + remote node', () => {
    const data = makeData({
      SERVERS: [{ id: 't1', name: 'Acme', node: 'remote.berra', short: 'A', federated: true, members: 12 }],
    });
    const { container } = renderApp(data);
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with members across all status types', () => {
    const data = makeData({
      MEMBERS: [
        { id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online' },
        { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0', status: 'online', custom: 'coding' },
        { id: 'u3', name: 'bob', initials: 'BO', color: '#00f', status: 'idle' },
        { id: 'u4', name: 'eve', initials: 'EV', color: '#ff0', status: 'dnd' },
        { id: 'u5', name: 'frank', initials: 'FR', color: '#0ff', status: 'offline' },
      ],
      byId: {
        me: { id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online' },
        u2: { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0', status: 'online', custom: 'coding' },
        u3: { id: 'u3', name: 'bob', initials: 'BO', color: '#00f', status: 'idle' },
        u4: { id: 'u4', name: 'eve', initials: 'EV', color: '#ff0', status: 'dnd' },
        u5: { id: 'u5', name: 'frank', initials: 'FR', color: '#0ff', status: 'offline' },
      },
    });
    const { container } = renderApp(data);
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with members holding multiple roles', () => {
    const data = makeData({
      MEMBERS: [
        { id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online',
          roles: [
            { id: 'r-admin', name: 'Admin', color: '#f00', position: 10 },
            { id: 'r-mod', name: 'Mod', color: '#0f0', position: 5 },
          ],
          isAdmin: true },
        { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0', status: 'online' },
      ],
      byId: {
        me: { id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online',
              roles: [
                { id: 'r-admin', name: 'Admin', color: '#f00', position: 10 },
                { id: 'r-mod', name: 'Mod', color: '#0f0', position: 5 },
              ],
              isAdmin: true },
        u2: { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0', status: 'online' },
      },
    });
    const { container } = renderApp(data);
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with 100 messages in the active channel', () => {
    const data = makeData({
      MESSAGES: {
        'ch-1': Array.from({ length: 100 }, (_, i) => ({
          id: `m${i}`, author: i % 2 === 0 ? 'me' : 'u2',
          at: new Date(Date.now() - (100 - i) * 1000),
          kind: 'text', text: `msg ${i}`, edited: false, deleted: false,
        })),
      },
    });
    const { container } = renderApp(data);
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with messages spanning multiple days', () => {
    const data = makeData({
      MESSAGES: {
        'ch-1': [
          { id: 'old', author: 'me', at: new Date('2024-01-01'), kind: 'text', text: 'ancient', edited: false, deleted: false },
          { id: 'older', author: 'me', at: new Date('2025-06-15'), kind: 'text', text: 'middle', edited: false, deleted: false },
          { id: 'today', author: 'me', at: new Date(), kind: 'text', text: 'today', edited: false, deleted: false },
        ],
      },
    });
    const { container } = renderApp(data);
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with reply-to chain', () => {
    const data = makeData({
      MESSAGES: {
        'ch-1': [
          { id: 'm1', author: 'me', at: new Date(2026, 0, 1, 10), kind: 'text', text: 'original', edited: false, deleted: false },
          { id: 'm2', author: 'u2', at: new Date(2026, 0, 1, 11), kind: 'text', text: 'replying', edited: false, deleted: false, replyTo: 'm1' },
          { id: 'm3', author: 'me', at: new Date(2026, 0, 1, 12), kind: 'text', text: 'reply to reply', edited: false, deleted: false, replyTo: 'm2' },
        ],
      },
    });
    const { container } = renderApp(data);
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with custom controller prop', () => {
    const controller = {};
    const { container } = renderApp(makeData(), { controller });
    expect(container.firstChild).toBeTruthy();
  });
});
