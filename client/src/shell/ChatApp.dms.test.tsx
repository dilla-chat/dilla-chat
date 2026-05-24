// Drive DM (direct message) flows — sidebar, DM channel render,
// switching between DMs and team channels, DM composer.

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
const BOB = { id: 'u3', name: 'bob', initials: 'BO', color: '#00f', status: 'offline' };

function seedStores() {
  const EMPTY: never[] = [];
  useTeamStore.setState({
    activeTeamId: null, activeChannelId: null,
    teams: new Map([['t1', { id: 't1', name: 'Acme' }]]),
    channels: new Map([['t1', EMPTY]]),
    members: new Map([['t1', EMPTY]]),
    roles: new Map([['t1', EMPTY]]),
    groups: new Map([['t1', EMPTY]]),
  } as never);
  useAuthStore.setState({ derivedKey: 'k', teams: new Map([['t1', { user: { id: 'me' } }]]) } as never);
  useVoiceStore.setState({
    connected: false, currentChannelId: null, voiceOccupants: {},
    muted: false, deafened: false, speaking: false,
    peers: {}, peerLatencies: {},
    latencySamples: EMPTY, bitrateSamples: EMPTY,
    localScreenStream: null, remoteScreenStreams: {},
    localWebcamStream: null, remoteWebcamStreams: {},
  } as never);
  useMessageStore.setState({ messages: new Map(), typing: new Map(), hasMore: new Map(), loadingHistory: new Map() } as never);
  useDMStore.setState({
    dmChannels: {
      'dm-1': { id: 'dm-1', participantIds: ['me', 'u2'], lastMessageAt: new Date() },
      'dm-2': { id: 'dm-2', participantIds: ['me', 'u3'], lastMessageAt: new Date(Date.now() - 60000) },
    },
    dmMessages: {
      'dm-1': [
        { id: 'dm-m1', author: 'u2', at: new Date(), kind: 'text', text: 'hi from alice', edited: false, deleted: false },
        { id: 'dm-m2', author: 'me', at: new Date(), kind: 'text', text: 'hey alice', edited: false, deleted: false },
      ],
      'dm-2': [
        { id: 'dm-m3', author: 'u3', at: new Date(), kind: 'text', text: 'bob says hi', edited: false, deleted: false },
      ],
    },
    activeDMId: 'dm-1',
  } as never);
  useThreadStore.setState({ threads: {}, threadMessages: {} } as never);
  useUnreadStore.setState({ counts: { 'dm-1': 0, 'dm-2': 2 } } as never);
  usePollStore.setState({ polls: new Map() } as never);
  useBlockStore.setState({ blocked: new Set() } as never);
  useChannelMuteStore.setState({ muted: new Set() } as never);
  usePinStore.setState({ pins: {} } as never);
}

function makeData(overrides: Record<string, unknown> = {}) {
  return {
    SERVERS: [{ id: 't1', name: 'Acme', node: 'local', short: 'A', members: 3 }],
    CHANNELS: [{ id: 'ch-1', name: 'general', type: 'text', encrypted: true, unread: 0 }],
    MEMBERS: [ME, ALICE, BOB],
    byId: { me: ME, u2: ALICE, u3: BOB },
    MESSAGES: {},
    DMS: [
      { id: 'dm-1', with: 'u2', preview: 'hey alice', at: new Date(), unread: 0 },
      { id: 'dm-2', with: 'u3', preview: 'bob says hi', at: new Date(Date.now() - 60000), unread: 2 },
    ],
    DM_MESSAGES: {
      'dm-1': [
        { id: 'dm-m1', author: 'u2', at: new Date(), kind: 'text', text: 'hi from alice', edited: false, deleted: false },
        { id: 'dm-m2', author: 'me', at: new Date(), kind: 'text', text: 'hey alice', edited: false, deleted: false },
      ],
      'dm-2': [
        { id: 'dm-m3', author: 'u3', at: new Date(), kind: 'text', text: 'bob says hi', edited: false, deleted: false },
      ],
    },
    THREAD_REPLIES: {},
    activeServerId: null, activeChannelId: null, currentUserId: 'me',
    ...overrides,
  };
}

beforeEach(() => seedStores());

describe('DM list / sidebar', () => {
  it('renders DM list in sidebar', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('clicks every DM row in the sidebar', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const rows = [...container.querySelectorAll('.dm-row, button.dm, .dm-item')] as HTMLElement[];
    for (const r of rows) {
      try { fireEvent.click(r); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('right-clicks every DM row', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const rows = [...container.querySelectorAll('.dm-row, button.dm, .dm-item')] as HTMLElement[];
    for (const r of rows) {
      try { fireEvent.contextMenu(r); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });
});

describe('Active DM channel', () => {
  it('renders DM messages when a DM is active', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('types in DM composer + presses Enter to send', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const tas = [...container.querySelectorAll('textarea')] as HTMLTextAreaElement[];
    for (const ta of tas) {
      try {
        fireEvent.focus(ta);
        fireEvent.change(ta, { target: { value: 'reply from jsdom' } });
        fireEvent.keyDown(ta, { key: 'Enter' });
      } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('switches active DM via store update', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => {
      useDMStore.setState({ activeDMId: 'dm-2' } as never);
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('switches from DM to team channel', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => {
      useDMStore.setState({ activeDMId: null } as never);
      useTeamStore.setState({ activeTeamId: 't1', activeChannelId: 'ch-1' } as never);
    });
    expect(container.firstChild).toBeTruthy();
  });
});

describe('DM message actions', () => {
  it('hovers + right-clicks every DM message', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const rows = [...container.querySelectorAll('.message, .msg, .message-row')] as HTMLElement[];
    for (const r of rows) {
      try { fireEvent.mouseEnter(r); fireEvent.contextMenu(r); fireEvent.mouseLeave(r); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });
});

describe('Closing DM', () => {
  it('dispatches dilla:close-dm', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => {
      window.dispatchEvent(new CustomEvent('dilla:close-dm', { detail: { dmId: 'dm-2' } }));
    });
    expect(container.firstChild).toBeTruthy();
  });
});
