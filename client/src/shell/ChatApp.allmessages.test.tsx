// Render ChatApp with every possible message variation to exercise
// every conditional in the renderer.

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
const ALICE = { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0', status: 'online', isAdmin: true };
const BOB = { id: 'u3', name: 'bob', initials: 'BO', color: '#00f', status: 'offline' };
const NOW = new Date();

function seedStores() {
  const EMPTY: never[] = [];
  useTeamStore.setState({
    activeTeamId: 't1', activeChannelId: 'ch-1',
    teams: new Map([['t1', { id: 't1', name: 'Acme' }]]),
    channels: new Map([['t1', EMPTY]]),
    members: new Map([['t1', EMPTY]]),
    roles: new Map([['t1', EMPTY]]),
    groups: new Map([['t1', EMPTY]]),
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

const ALL_KINDS = [
  // Plain text
  { id: 'mt', author: 'me', at: NOW, kind: 'text', text: 'plain', edited: false, deleted: false },
  // Long text (markdown)
  { id: 'ml', author: 'me', at: NOW, kind: 'text', text: '# heading\n\n```js\nconst x = 1;\n```\n\n> quote', edited: false, deleted: false },
  // Edited
  { id: 'me-msg', author: 'u2', at: NOW, kind: 'text', text: 'edited', edited: true, deleted: false },
  // Deleted
  { id: 'md', author: 'u2', at: NOW, kind: 'text', text: '[deleted]', edited: false, deleted: true },
  // Reactions
  { id: 'mr', author: 'me', at: NOW, kind: 'text', text: 'with rxn', edited: false, deleted: false, reactions: { '👍': ['me', 'u2'], '❤️': ['u3'] } },
  // Mention
  { id: 'mm', author: 'u3', at: NOW, kind: 'text', text: 'hey @me', edited: false, deleted: false, mentions: ['me'] },
  // Image
  { id: 'mi', author: 'u2', at: NOW, kind: 'image', text: '', edited: false, deleted: false,
    attachments: [{ id: 'a1', kind: 'image', name: 'pic.png', url: 'https://example/pic.png', width: 800, height: 600, size: 1024 }] },
  // Multiple attachments
  { id: 'ma', author: 'me', at: NOW, kind: 'file', text: '', edited: false, deleted: false,
    attachments: [
      { id: 'a2', kind: 'file', name: 'doc.pdf', url: 'https://example/doc.pdf', mime: 'application/pdf', size: 4096 },
      { id: 'a3', kind: 'image', name: 'screenshot.png', url: 'https://example/ss.png', width: 1200, height: 800 },
    ] },
  // Link with unfurl
  { id: 'mu', author: 'me', at: NOW, kind: 'text', text: 'check https://github.com/d/d/pull/47', edited: false, deleted: false },
  // GIF
  { id: 'mg', author: 'u3', at: NOW, kind: 'gif', text: '', edited: false, deleted: false,
    attachments: [{ id: 'a4', kind: 'gif', name: 'haha.gif', url: 'https://example/haha.gif', width: 200, height: 200 }] },
  // System
  { id: 'ms', author: '__system__', at: NOW, kind: 'system', text: 'me joined', edited: false, deleted: false },
  // Reply
  { id: 'mp', author: 'me', at: NOW, kind: 'text', text: 'replying', edited: false, deleted: false,
    replyTo: { id: 'mt', author: 'me', text: 'plain' } },
  // Thread parent
  { id: 'mth', author: 'u2', at: NOW, kind: 'text', text: 'thread parent', edited: false, deleted: false,
    thread: { count: 5, lastReplyAt: NOW, participants: ['me', 'u3'] } },
  // Poll
  { id: 'mpoll', author: 'u3', at: NOW, kind: 'poll', text: '', edited: false, deleted: false,
    question: 'Best framework?',
    options: [
      { id: 'o1', text: 'React', votes: 3 },
      { id: 'o2', text: 'Vue', votes: 1 },
    ] },
  // Failed send
  { id: 'mf', author: 'me', at: NOW, kind: 'text', text: 'failed', edited: false, deleted: false, state: 'failed' },
  // Pending
  { id: 'mpd', author: 'me', at: NOW, kind: 'text', text: 'pending', edited: false, deleted: false, state: 'pending' },
];

const CHANNEL = { id: 'ch-1', name: 'general', type: 'text', topic: 'general chat', encrypted: true, unread: 0 };

beforeEach(() => seedStores());

describe('ChatApp renders every message kind without crashing', () => {
  for (const msg of ALL_KINDS) {
    it(`renders message ${msg.id} (${msg.kind})`, () => {
      const { container } = render(
        <ShellDataProvider value={{
          SERVERS: [{ id: 't1', name: 'Acme' }],
          CHANNELS: [CHANNEL],
          MEMBERS: [ME, ALICE, BOB],
          byId: { me: ME, u2: ALICE, u3: BOB },
          MESSAGES: { 'ch-1': [msg] },
          DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: {},
          activeServerId: 't1', activeChannelId: 'ch-1', currentUserId: 'me',
        }}>
          <ChatApp theme={{ name: 'mesh' }} opts={{}} />
        </ShellDataProvider>,
      );
      expect(container.firstChild).toBeTruthy();
    });
  }

  it('renders all kinds together', () => {
    const { container } = render(
      <ShellDataProvider value={{
        SERVERS: [{ id: 't1', name: 'Acme' }],
        CHANNELS: [CHANNEL],
        MEMBERS: [ME, ALICE, BOB],
        byId: { me: ME, u2: ALICE, u3: BOB },
        MESSAGES: { 'ch-1': ALL_KINDS },
        DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: {},
        activeServerId: 't1', activeChannelId: 'ch-1', currentUserId: 'me',
      }}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });
});
