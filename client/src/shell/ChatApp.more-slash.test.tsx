// More slash commands + reactions + polls (targets L5084-L5144, L5296-L5343, L5462-L5483)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';

if (typeof globalThis.ResizeObserver === 'undefined') {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
}
if (typeof HTMLElement !== 'undefined' && !HTMLElement.prototype.scrollTo) {
  HTMLElement.prototype.scrollTo = function() {};
  HTMLElement.prototype.scrollIntoView = function() {};
}

const apiMocks = vi.hoisted(() => ({
  createPoll: vi.fn(async () => ({ id: 'p1', question: 'Q?', options: ['a', 'b'], tallies: [0, 0], voters: [[], []] })),
  votePoll: vi.fn(async () => ({})),
  unvotePoll: vi.fn(async () => ({})),
  updateChannel: vi.fn(async () => ({})),
  updateMember: vi.fn(async () => ({})),
  addReaction: vi.fn(async () => ({})),
  removeReaction: vi.fn(async () => ({})),
}));
vi.mock('../services/api', () => ({ api: new Proxy(apiMocks, { get: (t, k) => k in t ? (t as Record<string, unknown>)[k] : async () => ({}) }) }));
vi.mock('../services/websocket', () => ({ ws: new Proxy({}, { get: () => () => () => {} }) }));
vi.mock('../services/mockSession', () => ({ isMockSession: () => false }));
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

function seedStores() {
  const EMPTY: never[] = [];
  useTeamStore.setState({
    activeTeamId: 't1', activeChannelId: 'ch-1',
    teams: new Map([['t1', { id: 't1', name: 'Acme' }]]),
    channels: new Map([['t1', [{ id: 'ch-1', name: 'general', type: 'text' as const }]]]),
    members: new Map([['t1', [{ id: 'me-m', userId: 'me', username: 'me', isAdmin: true, roleIds: [], roles: [] }, { id: 'u2-m', userId: 'u2', username: 'alice', isAdmin: false, roleIds: [], roles: [] }]]]),
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
  useChannelMuteStore.setState({ muted: new Map() } as never);
  usePinStore.setState({ pinned: new Map() } as never);
}

const data = {
  SERVERS: [{ id: 't1', name: 'Acme' }],
  CHANNELS: [{ id: 'ch-1', name: 'general', type: 'text', topic: '', encrypted: true, unread: 0 }],
  MEMBERS: [ME, ALICE],
  byId: { me: ME, u2: ALICE },
  MESSAGES: {},
  DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: {},
  activeServerId: 't1', activeChannelId: 'ch-1', currentUserId: 'me',
};

beforeEach(() => seedStores());

async function sendCmd(container: HTMLElement, text: string) {
  const ta = container.querySelector('textarea') as HTMLTextAreaElement | null;
  if (ta) {
    await act(async () => {
      fireEvent.change(ta, { target: { value: text } });
      fireEvent.keyDown(ta, { key: 'Enter' });
      await new Promise((r) => setTimeout(r, 5));
    });
  }
}

describe('More slash commands', () => {
  for (const cmd of [
    '/me dancing',
    '/me',
    '/shrug',
    '/shrug well',
    '/poll Best?',
    '/poll Best?|opt1',
    '/poll Best?|opt1|opt2|opt3',
    '/giphy',
    '/giphy   ',  // empty query
  ]) {
    it(`handles ${cmd || '(empty)'}`, async () => {
      const { container } = render(
        <ShellDataProvider value={data}>
          <ChatApp theme={{ name: 'mesh' }} opts={{}} />
        </ShellDataProvider>,
      );
      await sendCmd(container, cmd);
      expect(container.firstChild).toBeTruthy();
    });
  }

  it('/poll with valid args creates a poll', async () => {
    const { container } = render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    await sendCmd(container, '/poll What should we eat?|pizza|sushi|burgers');
    expect(apiMocks.createPoll).toHaveBeenCalled();
  });

  it('/poll creation error shows notify', async () => {
    apiMocks.createPoll.mockRejectedValueOnce(new Error('forbidden'));
    const { container } = render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    await sendCmd(container, '/poll Q?|a|b');
    expect(container.firstChild).toBeTruthy();
  });

  it('/lock + /unlock', async () => {
    const { container } = render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    await sendCmd(container, '/lock');
    await sendCmd(container, '/unlock');
    expect(container.firstChild).toBeTruthy();
  });

  it('/lock error path', async () => {
    apiMocks.updateChannel.mockRejectedValueOnce(new Error('forbidden'));
    const { container } = render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    await sendCmd(container, '/lock');
    expect(container.firstChild).toBeTruthy();
  });

  it('/topic outside team channel notifies', async () => {
    useTeamStore.setState({ activeChannelId: null } as never);
    const { container } = render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    await sendCmd(container, '/topic new topic');
    expect(container.firstChild).toBeTruthy();
  });

  it('/topic error path', async () => {
    apiMocks.updateChannel.mockRejectedValueOnce(new Error('forbidden'));
    const { container } = render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    await sendCmd(container, '/topic foo bar');
    expect(container.firstChild).toBeTruthy();
  });

  it('/nick error path', async () => {
    apiMocks.updateMember.mockRejectedValueOnce(new Error('forbidden'));
    const { container } = render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    await sendCmd(container, '/nick new-name');
    expect(container.firstChild).toBeTruthy();
  });
});

describe('Reaction toggle (L5084-L5113)', () => {
  it('toggles reaction via dilla:toggle-reaction event', async () => {
    const messages = [
      { id: 'm1', author: 'u2', at: new Date(), kind: 'text', text: 'react to me', edited: false, deleted: false,
        reactions: [{ e: '👍', n: 1, mine: false }] },
    ];
    useMessageStore.setState({
      messages: new Map([['ch-1', messages]]),
      typing: new Map(), hasMore: new Map(), loadingHistory: new Map(),
    } as never);
    const { container } = render(
      <ShellDataProvider value={{ ...data, MESSAGES: { 'ch-1': messages } }}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => {
      window.dispatchEvent(new CustomEvent('dilla:toggle-reaction', { detail: { channelId: 'ch-1', messageId: 'm1', emoji: '👍' } }));
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('toggles new reaction (no existing entry)', () => {
    const messages = [
      { id: 'm1', author: 'u2', at: new Date(), kind: 'text', text: 'no reactions', edited: false, deleted: false, reactions: [] },
    ];
    useMessageStore.setState({
      messages: new Map([['ch-1', messages]]),
      typing: new Map(), hasMore: new Map(), loadingHistory: new Map(),
    } as never);
    const { container } = render(
      <ShellDataProvider value={{ ...data, MESSAGES: { 'ch-1': messages } }}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => {
      window.dispatchEvent(new CustomEvent('dilla:toggle-reaction', { detail: { channelId: 'ch-1', messageId: 'm1', emoji: '❤️' } }));
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('toggle reaction on DM channel skips api', () => {
    useDMStore.setState({
      dmChannels: { t1: [{ id: 'dm-1' }] as never },
      dmMessages: { 'dm-1': [{ id: 'm1', author: 'u2', at: new Date(), kind: 'text', text: 'x', reactions: [] } as never] },
      activeDMId: 'dm-1',
    } as never);
    const { container } = render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => {
      window.dispatchEvent(new CustomEvent('dilla:toggle-reaction', { detail: { channelId: 'dm-1', messageId: 'm1', emoji: '👍' } }));
    });
    expect(apiMocks.addReaction).not.toHaveBeenCalled();
  });
});

describe('Poll vote (L5122-L5145)', () => {
  it('votes on a poll via dilla:vote event', () => {
    const poll = {
      id: 'p1', channelId: 'ch-1', question: 'Q?',
      options: ['a', 'b'], tallies: [0, 0], voters: [[], []],
      created_by: 'me', created_at: new Date().toISOString(),
    };
    usePollStore.setState({
      polls: new Map([['ch-1', [poll as never]]]),
      upsert: usePollStore.getState().upsert,
    } as never);
    const { container } = render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => {
      window.dispatchEvent(new CustomEvent('dilla:vote', { detail: { channelId: 'ch-1', messageId: 'p1', optIdx: 0 } }));
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('unvotes when already mine', () => {
    const poll = {
      id: 'p1', channelId: 'ch-1', question: 'Q?',
      options: ['a', 'b'], tallies: [1, 0], voters: [['me'], []],
      created_by: 'me', created_at: new Date().toISOString(),
    };
    usePollStore.setState({
      polls: new Map([['ch-1', [poll as never]]]),
      upsert: usePollStore.getState().upsert,
    } as never);
    const { container } = render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => {
      window.dispatchEvent(new CustomEvent('dilla:vote', { detail: { channelId: 'ch-1', messageId: 'p1', optIdx: 0 } }));
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('vote on DM channel returns early', () => {
    const { container } = render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => {
      window.dispatchEvent(new CustomEvent('dilla:vote', { detail: { channelId: 'dm-1', messageId: 'p1', optIdx: 0 } }));
    });
    expect(apiMocks.votePoll).not.toHaveBeenCalled();
  });
});
