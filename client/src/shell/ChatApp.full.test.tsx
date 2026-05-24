// After replacing `?? []` with `?? EMPTY_LIST` in ChatApp/Settings
// selectors, jsdom can finally render the full ChatApp component
// without the useSyncExternalStore commit-effect loop. This file
// exercises the full integration path: render with various store
// configurations and assert the rendered output.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

// jsdom polyfills for APIs ChatApp uses but jsdom doesn't ship.
if (typeof globalThis.ResizeObserver === 'undefined') {
  class FakeResizeObserver {
    observe() { /* noop */ }
    unobserve() { /* noop */ }
    disconnect() { /* noop */ }
  }
  (globalThis as unknown as { ResizeObserver: typeof FakeResizeObserver }).ResizeObserver = FakeResizeObserver;
}
if (typeof HTMLElement !== 'undefined' && !HTMLElement.prototype.scrollTo) {
  HTMLElement.prototype.scrollTo = function() { /* noop */ };
  HTMLElement.prototype.scrollIntoView = function() { /* noop */ };
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

function seedAllStores() {
  const EMPTY: never[] = [];
  useTeamStore.setState({
    activeTeamId: 't1',
    activeChannelId: 'ch-1',
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
    MEMBERS: [{ id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online' }],
    byId: { me: { id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online' } },
    MESSAGES: {},
    DMS: [],
    DM_MESSAGES: {},
    THREAD_REPLIES: {},
    activeServerId: 't1',
    activeChannelId: 'ch-1',
    currentUserId: 'me',
    ...overrides,
  };
}

describe('ChatApp full render under jsdom (post-selector-stability fix)', () => {
  beforeEach(() => seedAllStores());

  it('mounts without infinite-loop crash', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('renders the team name from shell data', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.textContent).toContain('Acme');
  });

  it('renders messages from the active channel', () => {
    const data = makeData({
      MESSAGES: {
        'ch-1': [
          { id: 'm1', author: 'me', at: new Date(), kind: 'text', text: 'jsdom hello', edited: false, deleted: false },
        ],
      },
    });
    const { container } = render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.textContent).toContain('jsdom hello');
  });

  it('renders with multiple channels', () => {
    const data = makeData({
      CHANNELS: [
        { id: 'ch-1', name: 'general', type: 'text', encrypted: true, unread: 0 },
        { id: 'ch-2', name: 'voice', type: 'voice', encrypted: true, unread: 0, participants: [] },
        { id: 'ch-3', name: 'dev', type: 'text', encrypted: true, unread: 3 },
      ],
    });
    const { container } = render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with multiple members', () => {
    const data = makeData({
      MEMBERS: [
        { id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online' },
        { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0', status: 'online' },
        { id: 'u3', name: 'bob', initials: 'BO', color: '#00f', status: 'offline' },
      ],
      byId: {
        me: { id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online' },
        u2: { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0', status: 'online' },
        u3: { id: 'u3', name: 'bob', initials: 'BO', color: '#00f', status: 'offline' },
      },
    });
    const { container } = render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with rich=true', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} rich />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with custom opts (sidebar / members widths)', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{ sidebar: 300, members: 280, density: 'compact' }} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with DMs and DM_MESSAGES populated', () => {
    const data = makeData({
      DMS: [{ id: 'dm-1', with: 'u2', preview: 'sup', at: new Date(), unread: 1 }],
      DM_MESSAGES: {
        'dm-1': [{ id: 'dm-m1', author: 'u2', at: new Date(), kind: 'text', text: 'DM hi', edited: false, deleted: false }],
      },
      byId: {
        me: { id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online' },
        u2: { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0', status: 'online' },
      },
    });
    const { container } = render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with threads + replies', () => {
    const data = makeData({
      MEMBERS: [
        { id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online' },
        { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0', status: 'online' },
      ],
      byId: {
        me: { id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online' },
        u2: { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0', status: 'online' },
      },
      MESSAGES: {
        'ch-1': [{
          id: 'p1', author: 'me', at: new Date(), kind: 'text', text: 'parent', edited: false, deleted: false,
          thread: { count: 2, lastReplyAt: new Date(), participants: ['u2'] },
        }],
      },
      THREAD_REPLIES: {
        p1: [
          { id: 'r1', author: 'u2', at: new Date(), kind: 'text', text: 'reply 1', edited: false, deleted: false },
        ],
      },
    });
    const { container } = render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with a voice channel active', () => {
    const data = makeData({
      activeChannelId: 'ch-voice',
      CHANNELS: [{ id: 'ch-voice', name: 'lounge', type: 'voice', encrypted: true, unread: 0, participants: [] }],
    });
    const { container } = render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });
});
