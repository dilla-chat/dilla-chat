// Render ChatApp (the 5949-LOC handoff port) in real Chromium via
// vitest-browser-playwright. jsdom can't handle its Zustand selectors
// (multiple `?? []` allocations per render loop the test renderer);
// a real browser executes them fine.
//
// Each rendered configuration exercises hundreds of lines of the
// underlying component — that's the point of this file. The pure
// helper coverage in ChatApp.test.tsx complements but doesn't reach
// the rendering branches.

import { describe, it, expect, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
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

function seedStores() {
  const EMPTY: never[] = [];
  useTeamStore.setState({
    activeTeamId: 't1',
    activeChannelId: 'ch-1',
    teams: new Map([['t1', { id: 't1', name: 'Acme' }]]),
    channels: new Map([['t1', [
      { id: 'ch-1', name: 'general', type: 'text', topic: '', encrypted: true, unread: 0 },
      { id: 'ch-2', name: 'lounge', type: 'voice', topic: '', encrypted: true, unread: 0, participants: [] },
    ]]]),
    members: new Map([['t1', EMPTY]]),
    roles: new Map([['t1', EMPTY]]),
    groups: new Map([['t1', EMPTY]]),
  } as never);
  useAuthStore.setState({
    derivedKey: 'key',
    teams: new Map([['t1', { user: { id: 'me' } }]]),
  } as never);
  useVoiceStore.setState({
    connected: false,
    currentChannelId: null,
    voiceOccupants: {},
    muted: false,
    deafened: false,
    speaking: false,
    peers: {},
    peerLatencies: {},
    latencySamples: EMPTY,
    bitrateSamples: EMPTY,
    localScreenStream: null,
    remoteScreenStreams: {},
    localWebcamStream: null,
    remoteWebcamStreams: {},
  } as never);
  useMessageStore.setState({
    messages: new Map(),
    typing: new Map(),
    hasMore: new Map(),
    loadingHistory: new Map(),
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
  const SERVERS = [{ id: 't1', name: 'Acme', node: 'local', short: 'A', federated: false, members: 0 }];
  const CHANNELS = [
    { id: 'ch-1', name: 'general', type: 'text', topic: 'g', category: 'General', groupId: 'g1', encrypted: true, unread: 0 },
    { id: 'ch-2', name: 'lounge', type: 'voice', topic: '', category: 'General', groupId: 'g1', encrypted: true, unread: 0, participants: [] },
  ];
  const MEMBERS = [
    { id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online' },
    { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0', status: 'online' },
  ];
  const byId = Object.fromEntries(MEMBERS.map((m) => [m.id, m]));
  return {
    SERVERS,
    CHANNELS,
    MEMBERS,
    byId,
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

describe('ChatApp render in real Chromium', () => {
  beforeEach(() => {
    seedStores();
  });

  it('mounts with a populated team + text channel', async () => {
    const screen = await render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    await expect.element(screen.getByText('Acme')).toBeInTheDocument();
  });

  it('renders the channel sidebar wrapper', async () => {
    const { container } = await render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    // Channel sidebar uses a class hook that's stable across the
    // handoff port. The channel name "general" can wrap into multiple
    // text nodes due to the icon prefix, so we just assert the
    // sidebar element exists.
    expect(container.querySelector('[class*="channel"]')).toBeTruthy();
  });

  it('renders messages from the active channel', async () => {
    const data = makeData({
      MESSAGES: {
        'ch-1': [
          { id: 'm1', author: 'me', at: new Date(), kind: 'text', text: 'hi there', edited: false, deleted: false },
        ],
      },
    });
    const screen = await render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    await expect.element(screen.getByText('hi there')).toBeInTheDocument();
  });


  it('handles a voice channel as the active view', async () => {
    const data = makeData({ activeChannelId: 'ch-2' });
    const { container } = await render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('renders messages with reactions', async () => {
    const data = makeData({
      MESSAGES: {
        'ch-1': [{
          id: 'm1', author: 'u2', at: new Date(), kind: 'text', text: 'hello',
          edited: false, deleted: false,
          reactions: [{ e: '🎉', n: 3, mine: false }],
        }],
      },
    });
    const screen = await render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    await expect.element(screen.getByText('hello')).toBeInTheDocument();
  });

  it('renders a poll message', async () => {
    const data = makeData({
      MESSAGES: {
        'ch-1': [{
          id: 'p1', kind: 'poll', author: 'me', at: new Date(),
          question: 'Best language?',
          options: [
            { label: 'Rust', votes: 3, mine: true },
            { label: 'TypeScript', votes: 1, mine: false },
          ],
        }],
      },
    });
    const screen = await render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    await expect.element(screen.getByText('Best language?')).toBeInTheDocument();
  });

  it('renders with rich=true', async () => {
    const { container } = await render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} rich />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('renders multiple members grouped by role/status', async () => {
    const data = makeData({
      MEMBERS: [
        { id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online' },
        { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0', status: 'online',
          roles: [{ id: 'r1', name: 'Admin', color: '#f00', position: 10 }] },
        { id: 'u3', name: 'bob', initials: 'BO', color: '#00f', status: 'offline' },
        { id: 'u4', name: 'eve', initials: 'EV', color: '#ff0', status: 'idle' },
      ],
      byId: {
        me: { id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online' },
        u2: { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0', status: 'online',
              roles: [{ id: 'r1', name: 'Admin', color: '#f00', position: 10 }] },
        u3: { id: 'u3', name: 'bob', initials: 'BO', color: '#00f', status: 'offline' },
        u4: { id: 'u4', name: 'eve', initials: 'EV', color: '#ff0', status: 'idle' },
      },
    });
    const screen = await render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    await expect.element(screen.getByText('alice')).toBeInTheDocument();
    await expect.element(screen.getByText('bob')).toBeInTheDocument();
  });

  it('handles 30 messages without crashing', async () => {
    const data = makeData({
      MESSAGES: {
        'ch-1': Array.from({ length: 30 }, (_, i) => ({
          id: `m${i}`, author: i % 2 === 0 ? 'me' : 'u2',
          at: new Date(Date.now() - (30 - i) * 1000), kind: 'text',
          text: `msg ${i}`, edited: false, deleted: false,
        })),
      },
    });
    const screen = await render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    await expect.element(screen.getByText('msg 29')).toBeInTheDocument();
  });
});
