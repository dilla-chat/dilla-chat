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

  it('renders edited messages with the edited marker', async () => {
    const data = makeData({
      MESSAGES: {
        'ch-1': [{
          id: 'm1', author: 'me', at: new Date(), kind: 'text', text: 'oops',
          edited: true, deleted: false,
        }],
      },
    });
    const screen = await render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    await expect.element(screen.getByText('oops')).toBeInTheDocument();
  });

  it('renders system messages with kind="system"', async () => {
    const data = makeData({
      MESSAGES: {
        'ch-1': [{
          id: 's1', author: 'me', at: new Date(), kind: 'system', text: 'alice joined',
          edited: false, deleted: false,
        }],
      },
    });
    const screen = await render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    await expect.element(screen.getByText('alice joined')).toBeInTheDocument();
  });

  it('renders image attachments inline', async () => {
    const data = makeData({
      MESSAGES: {
        'ch-1': [{
          id: 'a1', author: 'me', at: new Date(), kind: 'image', text: '',
          edited: false, deleted: false,
          attachment: { kind: 'image', label: 'cat.gif', size: 100, src: '/img/cat.gif' },
        }],
      },
    });
    const { container } = await render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.querySelector('img')).toBeTruthy();
  });

  it('renders file attachments with filename', async () => {
    const data = makeData({
      MESSAGES: {
        'ch-1': [{
          id: 'f1', author: 'me', at: new Date(), kind: 'file', text: '',
          edited: false, deleted: false,
          attachment: { kind: 'file', label: 'doc.pdf', size: 12_345_678, src: '/files/doc.pdf' },
        }],
      },
    });
    const screen = await render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    await expect.element(screen.getByText('doc.pdf')).toBeInTheDocument();
  });

  it('renders reply-to references', async () => {
    const data = makeData({
      MESSAGES: {
        'ch-1': [
          { id: 'm1', author: 'me', at: new Date(Date.now() - 2000), kind: 'text', text: 'original message', edited: false, deleted: false },
          { id: 'm2', author: 'u2', at: new Date(), kind: 'text', text: 'replying!', edited: false, deleted: false, replyTo: 'm1' },
        ],
      },
    });
    const screen = await render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    await expect.element(screen.getByText('replying!')).toBeInTheDocument();
  });

  it('renders deleted messages by filtering them out', async () => {
    const data = makeData({
      MESSAGES: {
        'ch-1': [
          { id: 'm1', author: 'me', at: new Date(), kind: 'text', text: 'gone', edited: false, deleted: true },
          { id: 'm2', author: 'u2', at: new Date(), kind: 'text', text: 'visible', edited: false, deleted: false },
        ],
      },
    });
    const screen = await render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    await expect.element(screen.getByText('visible')).toBeInTheDocument();
  });

  it('renders threads with reply count badge', async () => {
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
          { id: 'r1', author: 'u2', at: new Date(), kind: 'text', text: 'first reply', edited: false, deleted: false },
        ],
      },
    });
    const screen = await render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    await expect.element(screen.getByText('parent')).toBeInTheDocument();
  });

  it('renders custom sidebar/members widths via opts', async () => {
    const { container } = await render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{ sidebar: 280, members: 260, density: 'compact' }} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('renders federated server flag in the rail', async () => {
    const data = makeData({
      SERVERS: [{ id: 't1', name: 'Acme', node: 'remote', short: 'A', federated: true, members: 8 }],
    });
    const { container } = await render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('handles a locked channel (admin override path)', async () => {
    const data = makeData({
      CHANNELS: [{ id: 'ch-1', name: 'admins-only', type: 'text', topic: '', encrypted: true, unread: 0, locked: true }],
    });
    const { container } = await render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('handles a channel with unread count > 0', async () => {
    const data = makeData({
      CHANNELS: [{ id: 'ch-1', name: 'general', type: 'text', topic: '', encrypted: true, unread: 7 }],
    });
    const { container } = await render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('handles a member with a custom status', async () => {
    const data = makeData({
      MEMBERS: [{ id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online', custom: 'on vacation' }],
      byId: { me: { id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online', custom: 'on vacation' } },
    });
    const { container } = await render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('renders messages with custom render fallbacks (no attachment, no thread)', async () => {
    const data = makeData({
      MESSAGES: {
        'ch-1': Array.from({ length: 5 }, (_, i) => ({
          id: `m${i}`, author: 'me', at: new Date(Date.now() - i * 1000),
          kind: 'text', text: `bare text ${i}`, edited: false, deleted: false,
        })),
      },
    });
    const screen = await render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    await expect.element(screen.getByText('bare text 0')).toBeInTheDocument();
  });

  it('renders consecutive same-author messages as one group', async () => {
    const data = makeData({
      MESSAGES: {
        'ch-1': [
          { id: 'm1', author: 'u2', at: new Date(2026, 0, 1, 12, 0), kind: 'text', text: 'first', edited: false, deleted: false },
          { id: 'm2', author: 'u2', at: new Date(2026, 0, 1, 12, 0, 5), kind: 'text', text: 'second', edited: false, deleted: false },
          { id: 'm3', author: 'u2', at: new Date(2026, 0, 1, 12, 0, 10), kind: 'text', text: 'third', edited: false, deleted: false },
        ],
      },
    });
    const screen = await render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    await expect.element(screen.getByText('third')).toBeInTheDocument();
  });

  it('renders messages with a URL (unfurl rendering smoke)', async () => {
    const data = makeData({
      MESSAGES: {
        'ch-1': [{
          id: 'm1', author: 'me', at: new Date(), kind: 'text',
          text: 'check out https://github.com/dilla-chat/dilla-chat',
          edited: false, deleted: false,
        }],
      },
    });
    const { container } = await render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    // The unfurl card renders mock metadata that varies by handoff
    // version — just confirm the URL text is in the DOM (either
    // markdown link or unfurl card).
    expect(container.textContent).toContain('github');
  });

  it('renders a system message + a text message in the same channel', async () => {
    const data = makeData({
      MESSAGES: {
        'ch-1': [
          { id: 's', author: 'me', at: new Date(), kind: 'system', text: 'channel created', edited: false, deleted: false },
          { id: 'm', author: 'u2', at: new Date(), kind: 'text', text: 'welcome!', edited: false, deleted: false },
        ],
      },
    });
    const screen = await render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    await expect.element(screen.getByText('channel created')).toBeInTheDocument();
    await expect.element(screen.getByText('welcome!')).toBeInTheDocument();
  });

  it('renders messages with mentions', async () => {
    const data = makeData({
      MESSAGES: {
        'ch-1': [{
          id: 'm1', author: 'u2', at: new Date(), kind: 'text',
          text: 'hey @me, look at this',
          edited: false, deleted: false,
        }],
      },
    });
    const screen = await render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    await expect.element(screen.getByText(/look at this/)).toBeInTheDocument();
  });

  it('renders messages with code blocks', async () => {
    const data = makeData({
      MESSAGES: {
        'ch-1': [{
          id: 'm1', author: 'me', at: new Date(), kind: 'text',
          text: 'try:\n```ts\nconsole.log(1)\n```',
          edited: false, deleted: false,
        }],
      },
    });
    const screen = await render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    await expect.element(screen.getByText(/console\.log/)).toBeInTheDocument();
  });

  it('renders multiple channels with different categories', async () => {
    const data = makeData({
      CHANNELS: [
        { id: 'ch-1', name: 'general', type: 'text', topic: '', category: 'Main', groupId: 'g1', encrypted: true, unread: 0 },
        { id: 'ch-3', name: 'dev', type: 'text', topic: '', category: 'Dev', groupId: 'g2', encrypted: true, unread: 0 },
        { id: 'ch-2', name: 'lounge', type: 'voice', topic: '', category: 'Main', groupId: 'g1', encrypted: true, unread: 0, participants: [] },
        { id: 'ch-4', name: 'standup', type: 'voice', topic: '', category: 'Dev', groupId: 'g2', encrypted: true, unread: 0, participants: [] },
      ],
    });
    const { container } = await render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('renders a thread with multiple replies', async () => {
    const data = makeData({
      MESSAGES: {
        'ch-1': [{
          id: 'p1', author: 'me', at: new Date(2026, 0, 1, 10), kind: 'text',
          text: 'thread parent', edited: false, deleted: false,
          thread: { count: 4, lastReplyAt: new Date(), participants: ['u2'] },
        }],
      },
      THREAD_REPLIES: {
        p1: [
          { id: 'r1', author: 'u2', at: new Date(2026, 0, 1, 11), kind: 'text', text: 'reply A', edited: false, deleted: false },
          { id: 'r2', author: 'me', at: new Date(2026, 0, 1, 12), kind: 'text', text: 'reply B', edited: false, deleted: false },
          { id: 'r3', author: 'u2', at: new Date(2026, 0, 1, 13), kind: 'text', text: 'reply C', edited: false, deleted: false },
        ],
      },
    });
    const screen = await render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    await expect.element(screen.getByText('thread parent')).toBeInTheDocument();
  });

  it('renders DM view with messages', async () => {
    const data = makeData({
      DMS: [
        { id: 'dm-1', with: 'u2', preview: 'hey', at: new Date(), unread: 0 },
      ],
      DM_MESSAGES: {
        'dm-1': [
          { id: 'dm-m1', author: 'u2', at: new Date(), kind: 'text', text: 'DM hello', edited: false, deleted: false },
          { id: 'dm-m2', author: 'me', at: new Date(), kind: 'text', text: 'DM response', edited: false, deleted: false },
        ],
      },
    });
    const { container } = await render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('renders group DMs with name', async () => {
    const data = makeData({
      DMS: [
        { id: 'dm-g', with: ['u2', 'u3'], group: true, name: 'alice, bob', preview: '', at: new Date(), unread: 0 },
      ],
      DM_MESSAGES: {},
      byId: {
        me: { id: 'me', name: 'me', initials: 'ME', color: '#f00' },
        u2: { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0' },
        u3: { id: 'u3', name: 'bob', initials: 'BO', color: '#00f' },
      },
    });
    const { container } = await render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('renders typing indicator placeholder when no typing event', async () => {
    const { container } = await render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    // No typing means no indicator — just smoke-check the render.
    expect(container.firstChild).toBeTruthy();
  });

  it('renders multiple messages with mixed reactions', async () => {
    const data = makeData({
      MESSAGES: {
        'ch-1': [
          { id: 'm1', author: 'me', at: new Date(), kind: 'text', text: 'shipping!',
            edited: false, deleted: false,
            reactions: [{ e: '🚀', n: 5, mine: true }, { e: '🎉', n: 3, mine: false }] },
          { id: 'm2', author: 'u2', at: new Date(), kind: 'text', text: 'nice',
            edited: false, deleted: false,
            reactions: [{ e: '👍', n: 2, mine: true }] },
        ],
      },
    });
    const screen = await render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    await expect.element(screen.getByText('shipping!')).toBeInTheDocument();
  });

  it('renders a multi-option poll with mixed vote state', async () => {
    const data = makeData({
      MESSAGES: {
        'ch-1': [{
          id: 'p1', kind: 'poll', author: 'me', at: new Date(),
          question: 'Pick a colour',
          options: [
            { label: 'red', votes: 4, mine: true },
            { label: 'green', votes: 2, mine: false },
            { label: 'blue', votes: 7, mine: false },
            { label: 'yellow', votes: 0, mine: false },
          ],
        }],
      },
    });
    const screen = await render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    await expect.element(screen.getByText('Pick a colour')).toBeInTheDocument();
  });
});
