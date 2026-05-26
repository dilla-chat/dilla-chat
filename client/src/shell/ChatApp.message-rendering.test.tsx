// Render ChatApp with every conceivable message rendering scenario.

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
const BOB = { id: 'u3', name: 'bob', initials: 'BO', color: '#00f', status: 'offline' };
const CHANNEL = { id: 'ch-1', name: 'general', type: 'text', topic: '', encrypted: true, unread: 0 };
const NOW = new Date();

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
  useChannelMuteStore.setState({ muted: new Map() } as never);
  usePinStore.setState({ pinned: new Map() } as never);
}

beforeEach(() => seedStores());

function dataWith(messages: unknown[]) {
  return {
    SERVERS: [{ id: 't1', name: 'Acme' }],
    CHANNELS: [CHANNEL],
    MEMBERS: [ME, ALICE, BOB],
    byId: { me: ME, u2: ALICE, u3: BOB },
    MESSAGES: { 'ch-1': messages },
    DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: {},
    activeServerId: 't1', activeChannelId: 'ch-1', currentUserId: 'me',
  };
}

const ALL_REACTIONS = {
  '👍': ['me', 'u2', 'u3'],
  '❤️': ['me'],
  '🎉': ['u2', 'u3'],
  '😄': ['u3'],
  '🚀': ['me', 'u2'],
};

describe('Message rendering — every flag combination', () => {
  it('reaction with many emojis', () => {
    const msgs = [{ id: 'm1', author: 'me', at: NOW, kind: 'text', text: 'rxn-heavy', edited: false, deleted: false, reactions: ALL_REACTIONS }];
    const { container } = render(
      <ShellDataProvider value={dataWith(msgs)}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('edited + reactions + thread (all flags)', () => {
    const msgs = [{
      id: 'm-all', author: 'u2', at: NOW, kind: 'text', text: 'maximum flags', edited: true, deleted: false,
      reactions: { '🔥': ['me', 'u3'] },
      thread: { count: 5, lastReplyAt: NOW, participants: ['me', 'u3'] },
    }];
    const { container } = render(
      <ShellDataProvider value={dataWith(msgs)}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('attachment-only message (no text)', () => {
    const msgs = [{
      id: 'm-att', author: 'me', at: NOW, kind: 'image', text: '', edited: false, deleted: false,
      attachments: [{ id: 'a1', kind: 'image', name: 'pic.png', url: 'https://example/pic.png', width: 800, height: 600 }],
    }];
    const { container } = render(
      <ShellDataProvider value={dataWith(msgs)}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('text + multiple attachments', () => {
    const msgs = [{
      id: 'm-multi', author: 'me', at: NOW, kind: 'text', text: 'here are some files', edited: false, deleted: false,
      attachments: [
        { id: 'a1', kind: 'image', name: 'pic.png', url: 'https://e/p.png', width: 800, height: 600 },
        { id: 'a2', kind: 'file', name: 'doc.pdf', url: 'https://e/d.pdf', mime: 'application/pdf', size: 4096 },
        { id: 'a3', kind: 'file', name: 'data.csv', url: 'https://e/d.csv', mime: 'text/csv', size: 2048 },
      ],
    }];
    const { container } = render(
      <ShellDataProvider value={dataWith(msgs)}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('grouped messages from same author (within 5min)', () => {
    const msgs = Array.from({ length: 5 }, (_, i) => ({
      id: 'm' + i, author: 'me', at: new Date(NOW.getTime() + i * 30_000),
      kind: 'text', text: 'msg ' + i, edited: false, deleted: false,
    }));
    const { container } = render(
      <ShellDataProvider value={dataWith(msgs)}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('alternating authors (separate groups)', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => ({
      id: 'm' + i, author: i % 2 === 0 ? 'me' : 'u2', at: new Date(NOW.getTime() + i * 1000),
      kind: 'text', text: 'msg ' + i, edited: false, deleted: false,
    }));
    const { container } = render(
      <ShellDataProvider value={dataWith(msgs)}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('mention message + non-mention together', () => {
    const msgs = [
      { id: 'm1', author: 'u2', at: NOW, kind: 'text', text: 'hey @me check this', edited: false, deleted: false, mentions: ['me'] },
      { id: 'm2', author: 'u3', at: NOW, kind: 'text', text: 'noise', edited: false, deleted: false },
      { id: 'm3', author: 'u2', at: NOW, kind: 'text', text: '@everyone read this', edited: false, deleted: false },
    ];
    const { container } = render(
      <ShellDataProvider value={dataWith(msgs)}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('code-block message', () => {
    const msgs = [{
      id: 'm-code', author: 'me', at: NOW, kind: 'text',
      text: '```typescript\nconst foo = "bar";\nfunction baz() {\n  return foo;\n}\n```',
      edited: false, deleted: false,
    }];
    const { container } = render(
      <ShellDataProvider value={dataWith(msgs)}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('link with unfurl', () => {
    const msgs = [{
      id: 'm-link', author: 'me', at: NOW, kind: 'text', text: 'check https://github.com/dilla/dilla/pull/47',
      edited: false, deleted: false,
      unfurls: [{ url: 'https://github.com/dilla/dilla/pull/47', title: 'PR #47', description: 'voice dock changes', siteName: 'GitHub' }],
    }];
    const { container } = render(
      <ShellDataProvider value={dataWith(msgs)}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('reply with quoted parent', () => {
    const msgs = [
      { id: 'm-parent', author: 'me', at: NOW, kind: 'text', text: 'original', edited: false, deleted: false },
      {
        id: 'm-reply', author: 'u2', at: NOW, kind: 'text', text: 'replying', edited: false, deleted: false,
        replyTo: { id: 'm-parent', author: 'me', text: 'original' },
      },
    ];
    const { container } = render(
      <ShellDataProvider value={dataWith(msgs)}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('poll message with all options', () => {
    const msgs = [{
      id: 'm-poll', author: 'u3', at: NOW, kind: 'poll', text: '', edited: false, deleted: false,
      question: 'What should we eat?',
      options: [
        { id: 'o1', text: 'Pizza', votes: 5 },
        { id: 'o2', text: 'Sushi', votes: 3 },
        { id: 'o3', text: 'Burgers', votes: 8 },
        { id: 'o4', text: 'Salad', votes: 1 },
      ],
    }];
    const { container } = render(
      <ShellDataProvider value={dataWith(msgs)}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('system message followed by user messages', () => {
    const msgs = [
      { id: 'm-sys', author: '__system__', at: NOW, kind: 'system', text: 'me joined the channel', edited: false, deleted: false },
      { id: 'm-1', author: 'me', at: NOW, kind: 'text', text: 'hello', edited: false, deleted: false },
    ];
    const { container } = render(
      <ShellDataProvider value={dataWith(msgs)}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('GIF message', () => {
    const msgs = [{
      id: 'm-gif', author: 'me', at: NOW, kind: 'gif', text: '', edited: false, deleted: false,
      attachments: [{ id: 'a1', kind: 'gif', name: 'haha.gif', url: 'https://giphy/haha.gif', width: 200, height: 200 }],
    }];
    const { container } = render(
      <ShellDataProvider value={dataWith(msgs)}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('pending + failed states', () => {
    const msgs = [
      { id: 'm-pending', author: 'me', at: NOW, kind: 'text', text: 'sending…', edited: false, deleted: false, state: 'pending' },
      { id: 'm-failed', author: 'me', at: NOW, kind: 'text', text: 'failed', edited: false, deleted: false, state: 'failed' },
    ];
    const { container } = render(
      <ShellDataProvider value={dataWith(msgs)}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('long text overflow', () => {
    const longText = 'word '.repeat(500);
    const msgs = [{ id: 'm-long', author: 'me', at: NOW, kind: 'text', text: longText, edited: false, deleted: false }];
    const { container } = render(
      <ShellDataProvider value={dataWith(msgs)}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });
});
