// Render ChatApp with every message KIND (text, image, file, code, poll,
// reply, edited, deleted, system, unfurl, gif), every channel TYPE
// (text, voice, announcements, stage), and every voice state — single
// big render to hit lots of branches in one go.

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
if (typeof HTMLMediaElement !== 'undefined' && !HTMLMediaElement.prototype.play) {
  HTMLMediaElement.prototype.play = function() { return Promise.resolve(); };
  HTMLMediaElement.prototype.pause = function() {};
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
const VC_STUB = { connected: false, currentChannelId: null, muted: false, deafened: false, speaking: false, voiceLevel: 0, peers: {}, join: () => {}, leave: () => {} };
vi.mock('../hooks/useVoiceConnection', () => ({ useVoiceConnection: () => VC_STUB }));
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
const BOB = { id: 'u3', name: 'bob', initials: 'BO', color: '#00f', status: 'idle' };

function seedStores() {
  const EMPTY: never[] = [];
  useTeamStore.setState({
    activeTeamId: 't1', activeChannelId: 'ch-text',
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
  usePinStore.setState({ pins: {} } as never);
}

const NOW = new Date();
const ALL_MSG_KINDS = [
  { id: 'k-text', author: 'me', at: NOW, kind: 'text', text: 'plain text', edited: false, deleted: false },
  { id: 'k-edited', author: 'me', at: NOW, kind: 'text', text: 'i was edited', edited: true, deleted: false },
  { id: 'k-deleted', author: 'me', at: NOW, kind: 'text', text: 'deleted', edited: false, deleted: true },
  { id: 'k-rxn', author: 'me', at: NOW, kind: 'text', text: 'with reactions', edited: false, deleted: false, reactions: { '👍': ['me', 'u2'], '❤️': ['u2'] } },
  { id: 'k-mention', author: 'u2', at: NOW, kind: 'text', text: 'hey <@me> check this', edited: false, deleted: false, mentions: ['me'] },
  { id: 'k-img', author: 'u2', at: NOW, kind: 'image', text: '', edited: false, deleted: false,
    attachments: [{ id: 'a1', kind: 'image', name: 'pic.png', url: 'https://example/pic.png', width: 800, height: 600, size: 1024 }] },
  { id: 'k-file', author: 'me', at: NOW, kind: 'file', text: '', edited: false, deleted: false,
    attachments: [{ id: 'a2', kind: 'file', name: 'doc.pdf', url: 'https://example/doc.pdf', mime: 'application/pdf', size: 4096 }] },
  { id: 'k-code', author: 'me', at: NOW, kind: 'text', text: '```js\nconst x = 1;\n```', edited: false, deleted: false },
  { id: 'k-link', author: 'me', at: NOW, kind: 'text', text: 'check https://example.com out', edited: false, deleted: false,
    unfurls: [{ url: 'https://example.com', title: 'Example', description: 'sample', siteName: 'Example', image: 'https://example/img.png' }] },
  { id: 'k-gif', author: 'u3', at: NOW, kind: 'gif', text: '', edited: false, deleted: false,
    attachments: [{ id: 'a3', kind: 'gif', name: 'haha.gif', url: 'https://example/haha.gif', width: 200, height: 200 }] },
  { id: 'k-system', author: '__system__', at: NOW, kind: 'system', text: 'me joined the channel', edited: false, deleted: false },
  { id: 'k-reply', author: 'me', at: NOW, kind: 'text', text: 'replying', edited: false, deleted: false,
    replyTo: { id: 'k-text', author: 'me', text: 'plain text' } },
  { id: 'k-thread', author: 'u2', at: NOW, kind: 'text', text: 'parent of thread', edited: false, deleted: false,
    thread: { count: 3, lastReplyAt: NOW, participants: ['me'] } },
  { id: 'k-poll', author: 'u3', at: NOW, kind: 'poll', text: '', edited: false, deleted: false,
    question: 'Best framework?',
    options: [
      { id: 'o1', text: 'React', votes: 3 },
      { id: 'o2', text: 'Vue', votes: 1 },
      { id: 'o3', text: 'Svelte', votes: 2 },
    ],
  },
  { id: 'k-failed', author: 'me', at: NOW, kind: 'text', text: 'failed to send', edited: false, deleted: false, state: 'failed' },
  { id: 'k-pending', author: 'me', at: NOW, kind: 'text', text: 'sending…', edited: false, deleted: false, state: 'pending' },
];

const ALL_CHANNEL_TYPES = [
  { id: 'ch-text', name: 'general', type: 'text', topic: 'general chat', encrypted: true, unread: 0 },
  { id: 'ch-text-locked', name: 'admin-only', type: 'text', topic: 'admin', encrypted: true, unread: 0, locked: true },
  { id: 'ch-text-unread', name: 'busy', type: 'text', encrypted: true, unread: 7 },
  { id: 'ch-voice', name: 'lounge', type: 'voice', encrypted: true, unread: 0, participants: ['u2'] },
  { id: 'ch-voice-full', name: 'meeting', type: 'voice', encrypted: true, unread: 0, participants: ['me', 'u2', 'u3'] },
  { id: 'ch-announce', name: 'announcements', type: 'announcements', encrypted: true, unread: 0 },
  { id: 'ch-stage', name: 'town-hall', type: 'stage', encrypted: true, unread: 0 },
];

function makeData(activeChannelId: string) {
  return {
    SERVERS: [{ id: 't1', name: 'Acme', node: 'local', short: 'A', members: 3 }],
    CHANNELS: ALL_CHANNEL_TYPES,
    MEMBERS: [ME, ALICE, BOB],
    byId: { me: ME, u2: ALICE, u3: BOB },
    MESSAGES: { 'ch-text': ALL_MSG_KINDS, 'ch-text-unread': ALL_MSG_KINDS.slice(0, 5) },
    DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: {},
    activeServerId: 't1', activeChannelId, currentUserId: 'me',
  };
}

beforeEach(() => seedStores());

describe('Render ChatApp with every message kind', () => {
  it('renders all message kinds in one channel', () => {
    const { container } = render(
      <ShellDataProvider value={makeData('ch-text')}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  for (const ch of ALL_CHANNEL_TYPES) {
    it(`renders with active channel = ${ch.type} (${ch.name})`, () => {
      const { container } = render(
        <ShellDataProvider value={makeData(ch.id)}>
          <ChatApp theme={{ name: 'mesh' }} opts={{}} />
        </ShellDataProvider>,
      );
      expect(container.firstChild).toBeTruthy();
    });
  }
});

describe('Render ChatApp with every voice state', () => {
  const VOICE_STATES = [
    { connected: false, currentChannelId: null, muted: false, deafened: false, speaking: false, label: 'disconnected' },
    { connected: true, currentChannelId: 'ch-voice', muted: false, deafened: false, speaking: false, label: 'connected idle' },
    { connected: true, currentChannelId: 'ch-voice', muted: true, deafened: false, speaking: false, label: 'muted' },
    { connected: true, currentChannelId: 'ch-voice', muted: true, deafened: true, speaking: false, label: 'deafened' },
    { connected: true, currentChannelId: 'ch-voice', muted: false, deafened: false, speaking: true, label: 'speaking' },
  ];

  for (const state of VOICE_STATES) {
    it(`renders with voice ${state.label}`, () => {
      const EMPTY: never[] = [];
      useVoiceStore.setState({
        ...state,
        voiceOccupants: { 'ch-voice': ['me', 'u2'] },
        peers: state.connected ? { u2: { speaking: true, level: 0.3 } } : {},
        peerLatencies: state.connected ? { u2: 42 } : {},
        latencySamples: EMPTY, bitrateSamples: EMPTY,
        localScreenStream: null, remoteScreenStreams: {},
        localWebcamStream: null, remoteWebcamStreams: {},
      } as never);
      const { container } = render(
        <ShellDataProvider value={makeData(state.connected ? 'ch-voice' : 'ch-text')}>
          <ChatApp theme={{ name: 'mesh' }} opts={{}} />
        </ShellDataProvider>,
      );
      expect(container.firstChild).toBeTruthy();
    });
  }
});

describe('Render ChatApp with various opts combinations', () => {
  const OPT_COMBOS = [
    { density: 'compact' },
    { density: 'comfortable' },
    { sidebar: 200 },
    { sidebar: 320 },
    { members: 200 },
    { members: 280 },
    { sidebar: 240, members: 240, density: 'compact' },
  ];

  for (const opts of OPT_COMBOS) {
    it(`renders with opts ${JSON.stringify(opts)}`, () => {
      const { container } = render(
        <ShellDataProvider value={makeData('ch-text')}>
          <ChatApp theme={{ name: 'mesh' }} opts={opts} />
        </ShellDataProvider>,
      );
      expect(container.firstChild).toBeTruthy();
    });
  }
});

describe('Render ChatApp with rich and bare modes', () => {
  it('renders rich=true', () => {
    const { container } = render(
      <ShellDataProvider value={makeData('ch-text')}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} rich />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('renders rich=false (default)', () => {
    const { container } = render(
      <ShellDataProvider value={makeData('ch-text')}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });
});
