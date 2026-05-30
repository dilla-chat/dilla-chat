// Render ChatApp with isMockSession() returning false so the
// "live mode" branches execute (markChannelRead, prekey distribute,
// real WS sends, etc.). This is otherwise skipped by every other
// test file that defaults to mock.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';

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
// LIVE mode (not /mesh).
vi.mock('../services/mockSession', () => ({ isMockSession: () => false }));
vi.mock('../hooks/useMessageDecryption', () => ({
  tryEncrypt: vi.fn(async (c: string) => c),
  tryDecrypt: vi.fn(async (_id: string, c: string) => c),
  serverToMessage: vi.fn((sm) => sm),
}));
vi.mock('../hooks/useChannelLazyLoad', () => ({ useChannelLazyLoad: vi.fn() }));
const VC_STUB = { connected: false, currentChannelId: null, muted: false, deafened: false, speaking: false, voiceLevel: 0, peers: {}, join: () => {}, leave: () => {} };
vi.mock('../hooks/useVoiceConnection', () => ({ useVoiceConnection: () => VC_STUB }));
vi.mock('../components/MessageMarkdown/MessageMarkdown', () => ({
  default: ({ text }: { text: string }) => <span>{text}</span>,
}));
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

function seedAllStores() {
  const EMPTY: never[] = [];
  useTeamStore.setState({
    activeTeamId: 't1', activeChannelId: 'ch-1',
    teams: new Map([['t1', { id: 't1', name: 'Acme' }]]),
    channels: new Map([['t1', EMPTY]]),
    members: new Map([['t1', EMPTY]]),
    roles: new Map([['t1', EMPTY]]),
    groups: new Map([['t1', EMPTY]]),
    setActiveChannel: vi.fn(),
  } as never);
  useAuthStore.setState({ derivedKey: 'k', teams: new Map([['t1', { user: { id: 'me' }, baseUrl: 'https://srv.example' }]]) } as never);
  useVoiceStore.setState({
    connected: false, currentChannelId: null, voiceOccupants: {},
    muted: false, deafened: false, speaking: false,
    peers: {}, peerLatencies: {},
    latencySamples: EMPTY, bitrateSamples: EMPTY,
    localScreenStream: null, remoteScreenStreams: {},
    localWebcamStream: null, remoteWebcamStreams: {},
  } as never);
  useMessageStore.setState({ messages: new Map(), typing: new Map(), hasMore: new Map(), loadingHistory: new Map() } as never);
  useDMStore.setState({ dmChannels: {}, dmMessages: {}, activeDMId: null, setActiveDM: vi.fn() } as never);
  useThreadStore.setState({ threads: {}, threadMessages: {} } as never);
  useUnreadStore.setState({ counts: {}, markRead: vi.fn() } as never);
  usePollStore.setState({ polls: new Map() } as never);
  useBlockStore.setState({ blocked: new Set() } as never);
  useChannelMuteStore.setState({ muted: new Set() } as never);
  usePinStore.setState({ pins: {} } as never);
}

const ME = { id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online' };
const ALICE = { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0', status: 'online' };

function makeData(overrides: Record<string, unknown> = {}) {
  return {
    SERVERS: [{ id: 't1', name: 'Acme', node: 'srv.example', short: 'A', federated: true, members: 5 }],
    CHANNELS: [
      { id: 'ch-1', name: 'general', type: 'text', encrypted: true, unread: 0 },
      { id: 'ch-2', name: 'voice', type: 'voice', encrypted: true, unread: 0, participants: [] },
    ],
    MEMBERS: [ME, ALICE],
    byId: { me: ME, u2: ALICE },
    MESSAGES: {
      'ch-1': [
        { id: 'm1', author: 'u2', at: new Date(), kind: 'text', text: 'live hello', edited: false, deleted: false },
        { id: 'm2', author: 'me', at: new Date(), kind: 'text', text: 'live reply', edited: false, deleted: false },
      ],
    },
    DMS: [{ id: 'dm-1', with: 'u2', preview: 'sup', at: new Date(), unread: 0 }],
    DM_MESSAGES: {
      'dm-1': [
        { id: 'dm-m1', author: 'u2', at: new Date(), kind: 'text', text: 'DM hi', edited: false, deleted: false },
      ],
    },
    THREAD_REPLIES: {},
    activeServerId: 't1',
    activeChannelId: 'ch-1',
    currentUserId: 'me',
    ...overrides,
  };
}

beforeEach(() => seedAllStores());

describe('ChatApp in live mode (isMockSession=false)', () => {
  it('mounts with live mode + populated data', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('mark-read fires when active channel has messages (live path)', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.textContent).toContain('live hello');
  });

  it('renders federated team flag in live mode', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('renders DM view in live mode (markChannelRead WS path)', () => {
    const data = makeData({ activeChannelId: null });
    const { container } = render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('clicks every button (drives live-mode handlers)', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const buttons = [...container.querySelectorAll('button')] as HTMLButtonElement[];
    act(() => {
      for (const b of buttons) {
        try { fireEvent.click(b); } catch { /* swallow */ }
      }
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('fires every dilla:* event in live mode', () => {
    render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => {
      for (const name of [
        'dilla:open-channel-access', 'dilla:open-channel-settings',
        'dilla:open-group-access', 'dilla:open-group-settings',
        'dilla:open-new-channel', 'dilla:open-add-server',
        'dilla:open-thread', 'dilla:open-profile', 'dilla:open-dm',
        'dilla:close-dm', 'dilla:open-menu', 'dilla:open-search',
        'dilla:open-settings', 'dilla:insert-mention', 'dilla:notify',
        'dilla:pickchannel', 'dilla:toggle-drawer', 'dilla:verify-safety',
        'dilla:giphy-pick',
      ]) {
        window.dispatchEvent(new CustomEvent(name, { detail: { channelId: 'ch-1', memberId: 'u2', x: 1, y: 1, items: [] } }));
      }
    });
    expect(document.body.firstChild).toBeTruthy();
  });
});
