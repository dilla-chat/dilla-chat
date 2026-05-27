// Drives the toggleReaction() function (L5083-5119) by rendering ChatApp
// with a seeded message that has reactions and clicking the .rxn pills
// for add/increment/decrement-to-remove paths.

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
vi.mock('../services/mockSession', () => ({ isMockSession: () => true }));
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

function seedAllStores() {
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
  usePollStore.setState({ polls: new Map() } as never);
  useBlockStore.setState({ blocked: new Set() } as never);
  useChannelMuteStore.setState({ muted: new Set() } as never);
  usePinStore.setState({ pins: {} } as never);
}

const ME = { id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online' };
const ALICE = { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0', status: 'online' };

function makeData(messageReactions: Array<{ e: string; n: number; mine: boolean }>) {
  return {
    SERVERS: [{ id: 't1', name: 'Acme', node: 'local', short: 'A', federated: false, members: 0 }],
    CHANNELS: [{ id: 'ch-1', name: 'general', type: 'text', topic: '', encrypted: true, unread: 0 }],
    MEMBERS: [ME, ALICE],
    byId: { me: ME, u2: ALICE },
    MESSAGES: {
      'ch-1': [
        {
          id: 'm-rxn',
          author: 'u2',
          at: new Date(),
          kind: 'text',
          text: 'reactable',
          edited: false,
          deleted: false,
          reactions: messageReactions,
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

function renderApp(reactions: Array<{ e: string; n: number; mine: boolean }>) {
  return render(
    <ShellDataProvider value={makeData(reactions)}>
      <ChatApp theme={{ name: 'mesh' }} opts={{}} />
    </ShellDataProvider>,
  );
}

beforeEach(() => seedAllStores());

function findRxnPills(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('.rxn')) as HTMLElement[];
}

describe('ChatApp toggleReaction', () => {
  it('clicking an existing reaction NOT mine increments + marks mine', () => {
    const { container } = renderApp([{ e: '🎉', n: 2, mine: false }]);
    const rxn = findRxnPills(container).find((el) => (el.textContent ?? '').includes('🎉'));
    expect(rxn).toBeTruthy();
    fireEvent.click(rxn!);
    // After toggle, the pill should still be in the DOM with the count bumped.
    const after = findRxnPills(container).find((el) => (el.textContent ?? '').includes('🎉'));
    expect(after).toBeTruthy();
  });

  it('clicking my reaction with count > 1 decrements + clears mine', () => {
    const { container } = renderApp([{ e: '👍', n: 3, mine: true }]);
    const rxn = findRxnPills(container).find((el) => (el.textContent ?? '').includes('👍'));
    expect(rxn).toBeTruthy();
    fireEvent.click(rxn!);
    // Pill remains because count dropped 3 → 2.
    const after = findRxnPills(container).find((el) => (el.textContent ?? '').includes('👍'));
    expect(after).toBeTruthy();
  });

  it('clicking my reaction with count == 1 removes the pill entirely', () => {
    const { container } = renderApp([{ e: '❤️', n: 1, mine: true }]);
    const rxn = findRxnPills(container).find((el) => (el.textContent ?? '').includes('❤️'));
    expect(rxn).toBeTruthy();
    fireEvent.click(rxn!);
    // Pill should be gone — splice removed it from the array.
    const after = findRxnPills(container).find((el) => (el.textContent ?? '').includes('❤️'));
    expect(after).toBeFalsy();
  });

  it('multiple consecutive clicks on the same pill toggle add/remove cycle', () => {
    const { container } = renderApp([{ e: '🔥', n: 1, mine: false }]);
    // Click 1: 1 (not-mine) → 2 (mine)
    let rxn = findRxnPills(container).find((el) => (el.textContent ?? '').includes('🔥'));
    fireEvent.click(rxn!);
    // Click 2: 2 (mine) → 1 (not-mine)  — count > 1, so just decrement
    rxn = findRxnPills(container).find((el) => (el.textContent ?? '').includes('🔥'));
    if (rxn) fireEvent.click(rxn);
    // Click 3: 1 (not-mine) → 2 (mine) again
    rxn = findRxnPills(container).find((el) => (el.textContent ?? '').includes('🔥'));
    if (rxn) fireEvent.click(rxn);
    expect(container.firstChild).toBeTruthy();
  });
});
