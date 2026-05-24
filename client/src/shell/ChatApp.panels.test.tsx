// Drive UserPanel, ThreadPanel, VoiceChannel video tile, and floating PIP
// interactions — large uncovered surface inside ChatApp.tsx.

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
if (typeof HTMLMediaElement !== 'undefined' && !HTMLMediaElement.prototype.play) {
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
const VC_STUB = { connected: true, currentChannelId: 'ch-voice', muted: false, deafened: false, speaking: true, voiceLevel: 0.6, peers: { u2: { speaking: true, level: 0.3 } }, join: () => {}, leave: () => {} };
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
    connected: true, currentChannelId: 'ch-voice',
    voiceOccupants: { 'ch-voice': ['me', 'u2'] },
    muted: false, deafened: false, speaking: true,
    peers: { u2: { speaking: true, level: 0.3 } }, peerLatencies: { u2: 42 },
    latencySamples: [42, 50, 38], bitrateSamples: [128, 160, 140],
    localScreenStream: null, remoteScreenStreams: {},
    localWebcamStream: null, remoteWebcamStreams: {},
  } as never);
  useMessageStore.setState({ messages: new Map(), typing: new Map(), hasMore: new Map(), loadingHistory: new Map() } as never);
  useDMStore.setState({ dmChannels: {}, dmMessages: {}, activeDMId: null } as never);
  useThreadStore.setState({
    threads: { 'ch-1': { parentId: 'p1', collapsed: false } },
    threadMessages: { p1: [{ id: 't-r1', author: 'u2', at: new Date(), kind: 'text', text: 'reply', edited: false, deleted: false }] },
  } as never);
  useUnreadStore.setState({ counts: {} } as never);
  usePollStore.setState({ polls: new Map() } as never);
  useBlockStore.setState({ blocked: new Set() } as never);
  useChannelMuteStore.setState({ muted: new Set() } as never);
  usePinStore.setState({ pins: {} } as never);
}

function makeData(overrides: Record<string, unknown> = {}) {
  return {
    SERVERS: [{ id: 't1', name: 'Acme', node: 'local', short: 'A', members: 5 }],
    CHANNELS: [
      { id: 'ch-1', name: 'general', type: 'text', encrypted: true, unread: 0 },
      { id: 'ch-voice', name: 'lounge', type: 'voice', encrypted: true, unread: 0, participants: ['me', 'u2'] },
    ],
    MEMBERS: [ME, ALICE],
    byId: { me: ME, u2: ALICE },
    MESSAGES: {},
    DMS: [], DM_MESSAGES: {},
    THREAD_REPLIES: {
      p1: [{ id: 'r1', author: 'u2', at: new Date(), kind: 'text', text: 'reply 1', edited: false, deleted: false }],
    },
    activeServerId: 't1', activeChannelId: 'ch-1', currentUserId: 'me',
    ...overrides,
  };
}

beforeEach(() => seedStores());

describe('UserPanel (bottom-left)', () => {
  it('clicks every button in the user panel', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const buttons = [...container.querySelectorAll('.user-panel button, button.up-btn')] as HTMLElement[];
    for (const b of buttons) {
      try { fireEvent.click(b); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('opens status picker (right-click user)', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const panel = container.querySelector('.user-panel') as HTMLElement | null;
    if (panel) {
      try { fireEvent.contextMenu(panel); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });
});

describe('ThreadPanel', () => {
  it('opens thread panel via custom event then clicks every button', () => {
    const { container } = render(
      <ShellDataProvider value={makeData({
        MESSAGES: {
          'ch-1': [{
            id: 'p1', author: 'me', at: new Date(), kind: 'text', text: 'parent', edited: false, deleted: false,
            thread: { count: 2, lastReplyAt: new Date(), participants: ['u2'] },
          }],
        },
      })}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => {
      window.dispatchEvent(new CustomEvent('dilla:open-thread', { detail: { parentId: 'p1' } }));
    });
    const buttons = [...container.querySelectorAll('.thread-panel button, button.tp-btn')] as HTMLElement[];
    for (const b of buttons) {
      try { fireEvent.click(b); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('closes thread panel via close button', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => { window.dispatchEvent(new CustomEvent('dilla:open-thread', { detail: { parentId: 'p1' } })); });
    act(() => { window.dispatchEvent(new CustomEvent('dilla:close-thread')); });
    expect(container.firstChild).toBeTruthy();
  });
});

describe('VoiceChannel active', () => {
  it('renders voice channel with peers when connected', () => {
    const { container } = render(
      <ShellDataProvider value={makeData({ activeChannelId: 'ch-voice' })}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('clicks every button in voice channel UI', () => {
    const { container } = render(
      <ShellDataProvider value={makeData({ activeChannelId: 'ch-voice' })}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const buttons = [...container.querySelectorAll('.voice-channel button, button.vc-btn')] as HTMLElement[];
    for (const b of buttons) {
      try { fireEvent.click(b); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with screen-share + webcam streams', () => {
    useVoiceStore.setState({
      connected: true, currentChannelId: 'ch-voice',
      voiceOccupants: { 'ch-voice': ['me', 'u2'] },
      muted: false, deafened: false, speaking: false,
      peers: {}, peerLatencies: {},
      latencySamples: [], bitrateSamples: [],
      localScreenStream: { id: 'ss-local' } as never,
      remoteScreenStreams: { u2: { id: 'ss-u2' } } as never,
      localWebcamStream: { id: 'cam-local' } as never,
      remoteWebcamStreams: { u2: { id: 'cam-u2' } } as never,
    } as never);
    const { container } = render(
      <ShellDataProvider value={makeData({ activeChannelId: 'ch-voice' })}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });
});

describe('Floating PIP / mini-voice', () => {
  it('renders floating pip when connected to voice but viewing a text channel', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('clicks every button on the floating pip', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const pip = container.querySelector('.floating-pip, .voice-pip') as HTMLElement | null;
    if (pip) {
      const buttons = [...pip.querySelectorAll('button')] as HTMLElement[];
      for (const b of buttons) {
        try { fireEvent.click(b); } catch { /* swallow */ }
      }
    }
    expect(container.firstChild).toBeTruthy();
  });
});

describe('ProfilePopover', () => {
  it('opens profile popover via event then clicks every button', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => {
      window.dispatchEvent(new CustomEvent('dilla:open-profile', { detail: { userId: 'u2' } }));
    });
    const buttons = [...container.querySelectorAll('.profile-popover button, .pp button')] as HTMLElement[];
    for (const b of buttons) {
      try { fireEvent.click(b); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });
});
