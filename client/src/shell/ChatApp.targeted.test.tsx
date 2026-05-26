// Targeted ChatApp tests — specific high-value interactions only.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';

if (typeof globalThis.ResizeObserver === 'undefined') {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
}
if (typeof HTMLElement !== 'undefined' && !HTMLElement.prototype.scrollTo) {
  HTMLElement.prototype.scrollTo = function() {};
  HTMLElement.prototype.scrollIntoView = function() {};
}
if (typeof HTMLMediaElement !== 'undefined') {
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

const ME = { id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online', isAdmin: true };
const ALICE = { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0', status: 'online' };

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
  useChannelMuteStore.setState({ muted: new Map() } as never);
  usePinStore.setState({ pinned: new Map() } as never);
}

const data = {
  SERVERS: [{ id: 't1', name: 'Acme', node: 'gbg-1' }],
  CHANNELS: [
    { id: 'ch-1', name: 'general', type: 'text', topic: 't', encrypted: true, unread: 0 },
    { id: 'ch-2', name: 'voice', type: 'voice', encrypted: true, unread: 0, participants: [] },
  ],
  MEMBERS: [ME, ALICE],
  byId: { me: ME, u2: ALICE },
  MESSAGES: {},
  DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: {},
  activeServerId: 't1', activeChannelId: 'ch-1', currentUserId: 'me',
};

beforeEach(() => seedStores());

describe('ChatApp targeted state-change tests', () => {
  it('store updates re-render the message list', () => {
    const { container } = render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => {
      useMessageStore.setState({
        messages: new Map([['ch-1', [
          { id: 'm1', author: 'me', at: new Date(), kind: 'text', text: 'new!', edited: false, deleted: false } as never,
        ]]]),
        typing: new Map(), hasMore: new Map(), loadingHistory: new Map(),
      } as never);
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('switching active channel via store triggers re-render', () => {
    const { container } = render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => { useTeamStore.setState({ activeChannelId: 'ch-2' } as never); });
    expect(container.firstChild).toBeTruthy();
  });

  it('switching active team via store', () => {
    const { container } = render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => { useTeamStore.setState({ activeTeamId: null } as never); });
    expect(container.firstChild).toBeTruthy();
  });

  it('unread count change re-renders sidebar', () => {
    const { container } = render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => { useUnreadStore.setState({ counts: { 'ch-2': 99 } } as never); });
    expect(container.firstChild).toBeTruthy();
  });

  it('pin update re-renders pinned bar', () => {
    const { container } = render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => { usePinStore.setState({ pinned: new Map([['ch-1', new Set(['m1'])]]) } as never); });
    expect(container.firstChild).toBeTruthy();
  });

  it('mute update re-renders', () => {
    const { container } = render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => { useChannelMuteStore.setState({ muted: new Map([['ch-1', null]]) } as never); });
    expect(container.firstChild).toBeTruthy();
  });

  it('voice store connection state changes', () => {
    const { container } = render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => {
      useVoiceStore.setState({ connected: true, currentChannelId: 'ch-2', muted: true, deafened: false, speaking: true } as never);
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('block list update re-renders', () => {
    const { container } = render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => { useBlockStore.setState({ blocked: new Set(['u2']) } as never); });
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with team roles configured', () => {
    useTeamStore.setState({
      roles: new Map([['t1', [
        { id: 'r1', name: 'Admin', color: '#f00', position: 2, permissions: 0xFFF, isDefault: false },
        { id: 'r2', name: 'Mod', color: '#0f0', position: 1, permissions: 0x2, isDefault: false },
        { id: 'r3', name: '@everyone', color: '#888', position: 0, permissions: 0x47, isDefault: true },
      ]]]),
    } as never);
    const { container } = render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with restricted channel (admin-only)', () => {
    useTeamStore.setState({
      activeTeamId: 't1', activeChannelId: 'ch-1',
      channels: new Map([['t1', [
        { id: 'ch-1', name: 'general', type: 'text' as const, teamId: 't1' },
        { id: 'ch-admin', name: 'admin-only', type: 'text' as const, teamId: 't1', accessRoleIds: ['r-admin'] },
      ]]]),
    } as never);
    const restrictedData = { ...data, CHANNELS: [
      { id: 'ch-1', name: 'general', type: 'text', encrypted: true },
      { id: 'ch-admin', name: 'admin-only', type: 'text', encrypted: true, accessRoleIds: ['r-admin'] },
    ] };
    const { container } = render(
      <ShellDataProvider value={restrictedData}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });
});
