// Mass-render ChatApp with every prop+state combination — broad sweep
// that exercises render branches in one file.

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

vi.mock('../services/websocket', () => ({ ws: new Proxy({}, { get: () => () => () => {} }) }));
vi.mock('../services/api', () => ({ api: new Proxy({}, { get: () => () => Promise.resolve({}) }) }));
vi.mock('../services/mockSession', () => ({ isMockSession: () => true }));
vi.mock('../hooks/useMessageDecryption', () => ({
  tryEncrypt: vi.fn(async (c: string) => c),
  tryDecrypt: vi.fn(async (_id: string, c: string) => c),
  serverToMessage: vi.fn((sm) => sm),
}));
vi.mock('../hooks/useChannelLazyLoad', () => ({ useChannelLazyLoad: vi.fn() }));
vi.mock('../hooks/useVoiceConnection', () => ({
  useVoiceConnection: () => ({ connected: false, currentChannelId: null, peers: {}, muted: false, deafened: false, speaking: false, voiceLevel: 0, join: vi.fn(), leave: vi.fn() }),
}));
vi.mock('../components/MessageMarkdown/MessageMarkdown', () => ({ default: ({ text }: { text: string }) => <span>{text}</span> }));
vi.mock('./icons', () => {
  const stub = () => <span data-icon />;
  return { Icon: new Proxy({}, { get: () => stub }), default: new Proxy({}, { get: () => stub }) };
});
vi.mock('./VoiceDockStats', () => ({ MiniMeter: () => <div />, VoiceDockLatency: () => <div />, VoiceDockBitrate: () => <div /> }));
vi.mock('./Avatar', () => ({
  Avatar: ({ member }: { member?: { name?: string } }) => <span>{member?.name}</span>,
  PlainAvatar: ({ member }: { member?: { name?: string } }) => <span>{member?.name}</span>,
  memberAvatarStyle: () => ({}),
  memberAvatarClass: () => '',
}));
vi.mock('./themes', () => ({ THEMES: { mesh: { name: 'mesh' }, themeVars: () => ({}) } }));

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

const ME = { id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online' };
const ALICE = { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0', status: 'online' };

function seedStores(over: Partial<Record<string, unknown>> = {}) {
  const EMPTY: never[] = [];
  useTeamStore.setState({
    activeTeamId: 't1', activeChannelId: 'ch-1',
    teams: new Map([['t1', { id: 't1', name: 'Acme' }]]),
    channels: new Map([['t1', EMPTY]]),
    members: new Map([['t1', EMPTY]]),
    roles: new Map([['t1', EMPTY]]),
    groups: new Map([['t1', EMPTY]]),
    ...over,
  } as never);
  useAuthStore.setState({ derivedKey: 'k', teams: new Map([['t1', { user: { id: 'me' } }]]) } as never);
  useVoiceStore.setState({
    connected: false, currentChannelId: null, voiceOccupants: {},
    muted: false, deafened: false, speaking: false, peers: {}, peerLatencies: {},
    latencySamples: EMPTY, bitrateSamples: EMPTY,
    localScreenStream: null, remoteScreenStreams: {},
    localWebcamStream: null, remoteWebcamStreams: {},
  } as never);
  useMessageStore.setState({ messages: new Map(), typing: new Map(), hasMore: new Map(), loadingHistory: new Map() } as never);
  useDMStore.setState({ dmChannels: {}, dmMessages: {}, activeDMId: null } as never);
  useThreadStore.setState({ threads: {}, threadMessages: {} } as never);
  useUnreadStore.setState({ counts: {} } as never);
  usePollStore.setState({ polls: new Map() } as never);
  useBlockStore.setState({ blocked: new Set() } as never);
  useChannelMuteStore.setState({ muted: new Set() } as never);
  usePinStore.setState({ pinned: new Map() } as never);
}

const CHANNELS = [
  { id: 'ch-1', name: 'general', type: 'text', topic: 'main', encrypted: true, unread: 0 },
  { id: 'ch-2', name: 'design', type: 'text', topic: '', encrypted: true, unread: 3, groupId: 'g1' },
  { id: 'ch-3', name: 'voice-1', type: 'voice', encrypted: true, unread: 0, participants: ['me'] },
  { id: 'ch-4', name: 'voice-2', type: 'voice', encrypted: true, unread: 0, participants: [] },
  { id: 'ch-5', name: 'admin-only', type: 'text', encrypted: true, unread: 0, accessRoleIds: ['r-admin'] },
];

const PEERS_CONNECTED = {
  me: { user_id: 'me', username: 'me', speaking: true, muted: false, deafened: false },
  u2: { user_id: 'u2', username: 'alice', speaking: false, muted: true, deafened: false, screen_sharing: true },
  u3: { user_id: 'u3', username: 'bob', speaking: false, muted: false, deafened: true, webcam_sharing: true },
};

const VARIANTS: Array<{ name: string; setup: () => void; data: Record<string, unknown> }> = [
  {
    name: 'empty channel',
    setup: () => {},
    data: { activeChannelId: 'ch-1', MESSAGES: { 'ch-1': [] } },
  },
  {
    name: 'channel with 50 messages (pagination zone)',
    setup: () => {},
    data: {
      activeChannelId: 'ch-1',
      MESSAGES: {
        'ch-1': Array.from({ length: 50 }, (_, i) => ({
          id: 'm' + i, author: i % 2 === 0 ? 'me' : 'u2', at: new Date(Date.now() - (50 - i) * 1000),
          kind: 'text', text: 'msg ' + i, edited: false, deleted: false,
        })),
      },
    },
  },
  {
    name: 'voice channel active + peers',
    setup: () => {
      useVoiceStore.setState({
        connected: true, currentChannelId: 'ch-3',
        peers: PEERS_CONNECTED,
        screenSharingUserId: null,
        remoteScreenStreams: {},
        muted: false, deafened: false, speaking: true,
      } as never);
    },
    data: { activeChannelId: 'ch-3' },
  },
  {
    name: 'with typing indicator',
    setup: () => {
      useMessageStore.setState({
        messages: new Map([['ch-1', []]]),
        typing: new Map([['ch-1', [{ userId: 'u2', username: 'alice', timestamp: Date.now() }]]]),
        hasMore: new Map(), loadingHistory: new Map(),
      } as never);
    },
    data: { activeChannelId: 'ch-1' },
  },
  {
    name: 'with unread badge',
    setup: () => {
      useUnreadStore.setState({ counts: { 'ch-1': 5, 'ch-2': 99, 'ch-3': 0 } } as never);
    },
    data: { activeChannelId: 'ch-1' },
  },
  {
    name: 'with blocked user',
    setup: () => {
      useBlockStore.setState({ blocked: new Set(['u2']) } as never);
    },
    data: { activeChannelId: 'ch-1' },
  },
  {
    name: 'with muted channel',
    setup: () => {
      useChannelMuteStore.setState({ muted: new Map([['ch-1', null]]) } as never);
    },
    data: { activeChannelId: 'ch-1' },
  },
  {
    name: 'with pinned messages',
    setup: () => {
      usePinStore.setState({ pinned: new Map([['ch-1', new Set(['m1'])]]) } as never);
      useMessageStore.setState({
        messages: new Map([['ch-1', [
          { id: 'm1', author: 'me', at: new Date(), kind: 'text', text: 'pinned!', edited: false, deleted: false } as never,
        ]]]),
        typing: new Map(), hasMore: new Map(), loadingHistory: new Map(),
      } as never);
    },
    data: { activeChannelId: 'ch-1' },
  },
  {
    name: 'with active DM',
    setup: () => {
      useDMStore.setState({
        activeDMId: 'dm-1',
        dmChannels: { t1: [{ id: 'dm-1', participantIds: ['me', 'u2'], lastMessageAt: new Date() }] },
        dmMessages: { 'dm-1': [
          { id: 'dmm1', channelId: 'dm-1', authorId: 'u2', content: 'dm msg', type: 'text', createdAt: new Date().toISOString() } as never,
        ] },
      } as never);
    },
    data: { activeChannelId: 'ch-1' },
  },
  {
    name: 'with thread parent',
    setup: () => {
      useThreadStore.setState({
        threads: { 'ch-1': [{ id: 'th-1', channel_id: 'ch-1', name: 'discussion' }] },
        threadMessages: { 'th-1': [
          { id: 'tm1', channelId: 'ch-1', authorId: 'u2', content: 'tx', type: 'text', createdAt: new Date().toISOString() } as never,
        ] },
      } as never);
    },
    data: { activeChannelId: 'ch-1' },
  },
];

beforeEach(() => seedStores());

describe('ChatApp big-render variants', () => {
  for (const v of VARIANTS) {
    it(`renders: ${v.name}`, () => {
      seedStores();
      v.setup();
      const { container } = render(
        <ShellDataProvider value={{
          SERVERS: [{ id: 't1', name: 'Acme', node: 'gbg-1' }],
          CHANNELS,
          MEMBERS: [ME, ALICE],
          byId: { me: ME, u2: ALICE },
          MESSAGES: {},
          DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: {},
          activeServerId: 't1', activeChannelId: 'ch-1', currentUserId: 'me',
          ...v.data,
        }}>
          <ChatApp theme={{ name: 'mesh' }} opts={{}} />
        </ShellDataProvider>,
      );
      expect(container.firstChild).toBeTruthy();
    });
  }

  it('renders with opts.bare', () => {
    const { container } = render(
      <ShellDataProvider value={{
        SERVERS: [{ id: 't1', name: 'Acme' }], CHANNELS,
        MEMBERS: [ME, ALICE], byId: { me: ME, u2: ALICE },
        MESSAGES: {}, DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: {},
        activeServerId: 't1', activeChannelId: 'ch-1', currentUserId: 'me',
      }}>
        <ChatApp theme={{ name: 'mesh' }} opts={{ bare: true }} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });
});
