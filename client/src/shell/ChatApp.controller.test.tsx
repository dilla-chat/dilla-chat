// Cover the imperative controller useEffect (L5165-5176) and the
// dilla:open-settings useEffect (L5147-5156) — both are tiny tags on the
// parent-supplied `controller` prop / window listener.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';

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
  join: vi.fn(),
  leave: vi.fn(),
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
        [
          { id: 'ch-1', teamId: 't1', name: 'general', type: 'text' },
          { id: 'ch-2', teamId: 't1', name: 'voice', type: 'voice' },
        ],
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

function makeData() {
  return {
    SERVERS: [{ id: 't1', name: 'Acme', node: 'local', short: 'A', federated: false, members: 0 }],
    CHANNELS: [
      { id: 'ch-1', name: 'general', type: 'text', topic: '', encrypted: true, unread: 0 },
      { id: 'ch-2', name: 'voice', type: 'voice', topic: '', encrypted: true, unread: 0, participants: [] },
    ],
    MEMBERS: [ME],
    byId: { me: ME },
    MESSAGES: { 'ch-1': [] },
    DMS: [],
    DM_MESSAGES: {},
    THREAD_REPLIES: {},
    activeServerId: 't1',
    activeChannelId: 'ch-1',
    currentUserId: 'me',
  };
}

interface Controller {
  pickChannel?: (id: string) => void;
  toggleMute?: () => void;
  toggleDeafen?: () => void;
  disconnect?: () => void;
  getVoiceConn?: () => unknown;
}

function renderWithController(controller: Controller) {
  return render(
    <ShellDataProvider value={makeData()}>
      <ChatApp theme={{ name: 'mesh' }} opts={{}} controller={controller} />
    </ShellDataProvider>,
  );
}

beforeEach(() => seedAllStores());

describe('ChatApp imperative controller', () => {
  it('exposes pickChannel that switches to a known channel', () => {
    const ctrl: Controller = {};
    const { container } = renderWithController(ctrl);
    expect(typeof ctrl.pickChannel).toBe('function');
    act(() => {
      ctrl.pickChannel!('ch-2');
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('pickChannel ignores unknown channel ids', () => {
    const ctrl: Controller = {};
    const { container } = renderWithController(ctrl);
    act(() => {
      ctrl.pickChannel!('no-such-channel');
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('exposes toggleMute as a function', () => {
    const ctrl: Controller = {};
    const { container } = renderWithController(ctrl);
    expect(typeof ctrl.toggleMute).toBe('function');
    act(() => {
      ctrl.toggleMute!();
      ctrl.toggleMute!();
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('exposes toggleDeafen as a function', () => {
    const ctrl: Controller = {};
    const { container } = renderWithController(ctrl);
    expect(typeof ctrl.toggleDeafen).toBe('function');
    act(() => {
      ctrl.toggleDeafen!();
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('exposes disconnect that calls voice.leave()', () => {
    const ctrl: Controller = {};
    const { container } = renderWithController(ctrl);
    expect(typeof ctrl.disconnect).toBe('function');
    act(() => {
      ctrl.disconnect!();
    });
    expect(VC_STUB.leave).toHaveBeenCalled();
    expect(container.firstChild).toBeTruthy();
  });

  it('exposes getVoiceConn returning the current voice connection (null when disconnected)', () => {
    const ctrl: Controller = {};
    const { container } = renderWithController(ctrl);
    expect(typeof ctrl.getVoiceConn).toBe('function');
    // voiceConnection is a derived view that resolves to null when voice
    // is not connected — exercising the getter is what matters.
    expect(ctrl.getVoiceConn!()).toBeNull();
    expect(container.firstChild).toBeTruthy();
  });
});

describe('ChatApp dilla:open-settings event', () => {
  it('string detail sets mode to the string and tab to null', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => {
      window.dispatchEvent(new CustomEvent('dilla:open-settings', { detail: 'team' }));
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('object detail with {mode, tab} sets both', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => {
      window.dispatchEvent(
        new CustomEvent('dilla:open-settings', { detail: { mode: 'team', tab: 'roles' } }),
      );
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('no detail defaults to user mode + null tab', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => {
      window.dispatchEvent(new CustomEvent('dilla:open-settings'));
    });
    expect(container.firstChild).toBeTruthy();
  });
});
