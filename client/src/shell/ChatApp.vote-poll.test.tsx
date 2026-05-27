// Drives the voteOnPoll() function (L5122-5144) by rendering ChatApp
// with a kind='poll' message + a corresponding pollStore entry, then
// clicking the .poll-opt buttons to fire onVote → voteOnPoll.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

if (typeof globalThis.ResizeObserver === 'undefined') {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
}
if (typeof HTMLElement !== 'undefined' && !HTMLElement.prototype.scrollTo) {
  HTMLElement.prototype.scrollTo = function () {};
  HTMLElement.prototype.scrollIntoView = function () {};
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

vi.mock('../services/websocket', () => ({ ws: new Proxy({}, { get: () => () => () => {} }) }));
vi.mock('../services/api', () => ({ api: new Proxy({}, { get: () => () => Promise.resolve({}) }) }));
vi.mock('../services/mockSession', () => ({ isMockSession: () => false }));
vi.mock('../hooks/useMessageDecryption', () => ({
  tryEncrypt: vi.fn(async (c: string) => c),
  tryDecrypt: vi.fn(async (_id: string, c: string) => c),
  serverToMessage: vi.fn((sm) => sm),
}));
vi.mock('../hooks/useChannelLazyLoad', () => ({ useChannelLazyLoad: vi.fn() }));
const VC_STUB = {
  connected: false,
  currentChannelId: null,
  muted: false,
  deafened: false,
  speaking: false,
  voiceLevel: 0,
  peers: {},
  join: () => {},
  leave: () => {},
};
vi.mock('../hooks/useVoiceConnection', () => ({ useVoiceConnection: () => VC_STUB }));
vi.mock('../components/MessageMarkdown/MessageMarkdown', () => ({
  default: ({ text }: { text: string }) => <span>{text}</span>,
}));
vi.mock('./icons', () => {
  const stub = () => <span data-icon />;
  return { Icon: new Proxy({}, { get: () => stub }), default: new Proxy({}, { get: () => stub }) };
});
vi.mock('./VoiceDockStats', () => ({
  MiniMeter: () => <div />,
  VoiceDockLatency: () => <div />,
  VoiceDockBitrate: () => <div />,
}));
vi.mock('./Avatar', () => ({
  Avatar: ({ member }: { member?: { name?: string } }) => <span>{member?.name}</span>,
  PlainAvatar: ({ member }: { member?: { name?: string } }) => <span>{member?.name}</span>,
  memberAvatarStyle: () => ({}),
  memberAvatarClass: () => '',
}));
vi.mock('./themes', () => ({ THEMES: { mesh: { name: 'mesh' }, themeVars: () => ({}) } }));

function seedAllStoresWithPoll(myVote?: number) {
  const EMPTY: never[] = [];
  useTeamStore.setState({
    activeTeamId: 't1',
    activeChannelId: 'ch-1',
    teams: new Map([['t1', { id: 't1', name: 'Acme' }]]),
    channels: new Map([
      [
        't1',
        [{ id: 'ch-1', teamId: 't1', name: 'general', type: 'text' }],
      ],
    ]),
    members: new Map([
      [
        't1',
        [
          { id: 'm1', userId: 'me', username: 'me', displayName: 'Me', publicKeyHex: '', avatarUrl: '', isAdmin: true, roles: [] },
        ],
      ],
    ]),
    roles: new Map([['t1', EMPTY]]),
    groups: new Map([['t1', EMPTY]]),
  } as never);
  useAuthStore.setState({ derivedKey: 'k', teams: new Map([['t1', { user: { id: 'me' } }]]) } as never);
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
  useMessageStore.setState({ messages: new Map(), typing: new Map(), hasMore: new Map(), loadingHistory: new Map() } as never);
  useDMStore.setState({ dmChannels: {}, dmMessages: {}, activeDMId: null } as never);
  useThreadStore.setState({ threads: {}, threadMessages: {} } as never);
  useUnreadStore.setState({ counts: {} } as never);
  // SEED the pollStore so voteOnPoll's lookup at L5128-5130 finds the poll.
  const voters: string[][] = [[], [], []];
  if (typeof myVote === 'number') voters[myVote] = ['me'];
  usePollStore.setState({
    polls: new Map([
      [
        'ch-1',
        [
          {
            id: 'p1',
            channelId: 'ch-1',
            question: 'Best?',
            options: ['rust', 'go', 'python'],
            tallies: voters.map((v) => v.length),
            voters,
            createdBy: 'me',
            createdAt: '',
          },
        ],
      ],
    ]),
  } as never);
  useBlockStore.setState({ blocked: new Set() } as never);
  useChannelMuteStore.setState({ muted: new Set() } as never);
  usePinStore.setState({ pins: {} } as never);
  (window as unknown as { SHELL_DATA?: { currentUserId?: string } }).SHELL_DATA = {
    currentUserId: 'me',
  };
}

const ME = { id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online' };

function makeData(myMineIndex?: number) {
  return {
    SERVERS: [{ id: 't1', name: 'Acme', node: 'local', short: 'A', federated: false, members: 0 }],
    CHANNELS: [{ id: 'ch-1', name: 'general', type: 'text', topic: '', encrypted: true, unread: 0 }],
    MEMBERS: [ME],
    byId: { me: ME },
    MESSAGES: {
      'ch-1': [
        {
          id: 'p1',
          author: 'me',
          at: new Date(),
          kind: 'poll',
          question: 'Best?',
          options: [
            { label: 'rust', votes: myMineIndex === 0 ? 1 : 0, mine: myMineIndex === 0 },
            { label: 'go', votes: myMineIndex === 1 ? 1 : 0, mine: myMineIndex === 1 },
            { label: 'python', votes: myMineIndex === 2 ? 1 : 0, mine: myMineIndex === 2 },
          ],
        },
      ],
    },
    DMS: [],
    DM_MESSAGES: {},
    THREAD_REPLIES: {},
    activeServerId: 't1',
    activeChannelId: 'ch-1',
    currentUserId: 'me',
  };
}

function renderApp(myMineIndex?: number) {
  return render(
    <ShellDataProvider value={makeData(myMineIndex)}>
      <ChatApp theme={{ name: 'mesh' }} opts={{}} />
    </ShellDataProvider>,
  );
}

beforeEach(() => seedAllStoresWithPoll());

function findPollOptions(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('.poll-opt')) as HTMLElement[];
}

describe('ChatApp voteOnPoll', () => {
  it('clicking a fresh option adds my vote', () => {
    seedAllStoresWithPoll();
    const { container } = renderApp();
    const opts = findPollOptions(container);
    expect(opts.length).toBeGreaterThan(0);
    fireEvent.click(opts[0]);
    // Confirm the poll store now reflects a vote from me.
    const stored = usePollStore.getState().polls.get('ch-1')?.[0];
    expect(stored?.voters[0]).toContain('me');
  });

  it('clicking the same option twice clears my vote', () => {
    seedAllStoresWithPoll(0); // already voted on option 0
    const { container } = renderApp(0);
    const opts = findPollOptions(container);
    fireEvent.click(opts[0]); // alreadyMine → remove
    const stored = usePollStore.getState().polls.get('ch-1')?.[0];
    expect(stored?.voters[0]).not.toContain('me');
  });

  it('clicking a different option moves my single-choice vote', () => {
    seedAllStoresWithPoll(0);
    const { container } = renderApp(0);
    const opts = findPollOptions(container);
    fireEvent.click(opts[2]);
    const stored = usePollStore.getState().polls.get('ch-1')?.[0];
    expect(stored?.voters[0]).not.toContain('me');
    expect(stored?.voters[2]).toContain('me');
  });
});
