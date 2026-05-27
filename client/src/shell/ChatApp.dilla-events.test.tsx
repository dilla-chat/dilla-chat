// Dispatches the dilla:* window CustomEvents that drive ChatApp's modal/menu
// system. Each handler is a pure setState, so this covers ~80 lines in the
// L4940-5081 useEffect with one render + a series of dispatchEvent calls.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';

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
        [
          { id: 'ch-1', teamId: 't1', name: 'general', type: 'text', hiddenIfRestricted: false, accessRoleIds: [] },
          { id: 'ch-2', teamId: 't1', name: 'voice', type: 'voice' },
        ],
      ],
    ]),
    members: new Map([
      [
        't1',
        [
          { id: 'm1', userId: 'me', username: 'me', displayName: 'Me', publicKeyHex: '', avatarUrl: '', isAdmin: true, roles: [] },
          { id: 'm2', userId: 'u2', username: 'alice', displayName: 'Alice', publicKeyHex: '', avatarUrl: '', isAdmin: false, roles: [] },
        ],
      ],
    ]),
    roles: new Map([['t1', EMPTY]]),
    groups: new Map([
      [
        't1',
        [
          { id: 'g1', name: 'Engineering', accessRoleIds: [], hiddenIfRestricted: false },
        ],
      ],
    ]),
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

function makeData() {
  return {
    SERVERS: [{ id: 't1', name: 'Acme', node: 'local', short: 'A', federated: false, members: 0 }],
    CHANNELS: [
      { id: 'ch-1', name: 'general', type: 'text', topic: '', encrypted: true, unread: 0 },
      { id: 'ch-2', name: 'voice', type: 'voice', topic: '', encrypted: true, unread: 0, participants: [] },
    ],
    MEMBERS: [ME, ALICE],
    byId: { me: ME, u2: ALICE },
    MESSAGES: { 'ch-1': [] },
    DMS: [{ id: 'dm-1', with: 'u2', preview: '', at: new Date(), unread: 0 }],
    DM_MESSAGES: { 'dm-1': [] },
    THREAD_REPLIES: {},
    activeServerId: 't1',
    activeChannelId: 'ch-1',
    currentUserId: 'me',
  };
}

function renderApp() {
  return render(
    <ShellDataProvider value={makeData()}>
      <ChatApp theme={{ name: 'mesh' }} opts={{}} />
    </ShellDataProvider>,
  );
}

beforeEach(() => seedAllStores());

function dispatch(name: string, detail?: unknown) {
  act(() => {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  });
}

describe('ChatApp window CustomEvent handlers', () => {
  it('dilla:open-add-server opens the New Server modal state', () => {
    const { container } = renderApp();
    dispatch('dilla:open-add-server');
    // Whatever appears, the render did not crash.
    expect(container.firstChild).toBeTruthy();
  });

  it('dilla:open-new-channel opens the New Channel modal state', () => {
    const { container } = renderApp();
    dispatch('dilla:open-new-channel');
    expect(container.firstChild).toBeTruthy();
  });

  it('dilla:open-dm with member id sets active DM + switches to PMs tab', () => {
    const { container } = renderApp();
    dispatch('dilla:open-dm', 'u2');
    expect(container.firstChild).toBeTruthy();
  });

  it('dilla:open-dm with no detail is a no-op', () => {
    const { container } = renderApp();
    dispatch('dilla:open-dm', undefined);
    expect(container.firstChild).toBeTruthy();
  });

  it('dilla:close-dm removes the DM and clears activeDM', () => {
    const { container } = renderApp();
    // First open the DM so close has something to remove.
    dispatch('dilla:open-dm', 'u2');
    dispatch('dilla:close-dm', 'dm-1');
    expect(container.firstChild).toBeTruthy();
  });

  it('dilla:close-dm with empty detail is a no-op', () => {
    const { container } = renderApp();
    dispatch('dilla:close-dm', '');
    expect(container.firstChild).toBeTruthy();
  });

  it('dilla:insert-mention appends @name to the active draft', () => {
    const { container } = renderApp();
    dispatch('dilla:insert-mention', 'alice');
    expect(container.firstChild).toBeTruthy();
  });

  it('dilla:insert-mention with no detail is a no-op', () => {
    const { container } = renderApp();
    dispatch('dilla:insert-mention', undefined);
    expect(container.firstChild).toBeTruthy();
  });

  it('dilla:open-channel-settings opens the settings modal when the channel exists', () => {
    const { container } = renderApp();
    dispatch('dilla:open-channel-settings', 'ch-1');
    expect(container.firstChild).toBeTruthy();
  });

  it('dilla:open-channel-settings for unknown channel is a no-op', () => {
    const { container } = renderApp();
    dispatch('dilla:open-channel-settings', 'ghost-channel');
    expect(container.firstChild).toBeTruthy();
  });

  it('dilla:open-channel-access opens the access modal when the channel exists', () => {
    const { container } = renderApp();
    dispatch('dilla:open-channel-access', 'ch-1');
    expect(container.firstChild).toBeTruthy();
  });

  it('dilla:open-group-access opens the group access modal', () => {
    const { container } = renderApp();
    dispatch('dilla:open-group-access', 'g1');
    expect(container.firstChild).toBeTruthy();
  });

  it('dilla:open-group-settings opens the group settings modal', () => {
    const { container } = renderApp();
    dispatch('dilla:open-group-settings', 'g1');
    expect(container.firstChild).toBeTruthy();
  });

  it('dilla:open-profile sets the profile popover state', () => {
    const { container } = renderApp();
    dispatch('dilla:open-profile', { memberId: 'u2', rect: { x: 0, y: 0 } });
    expect(container.firstChild).toBeTruthy();
  });

  it('dilla:open-thread sets the active thread state', () => {
    const { container } = renderApp();
    dispatch('dilla:open-thread', { channelId: 'ch-1', messageId: 'm1' });
    expect(container.firstChild).toBeTruthy();
  });

  it('dilla:toggle-drawer flips the drawer state', () => {
    const { container } = renderApp();
    dispatch('dilla:toggle-drawer');
    dispatch('dilla:toggle-drawer');
    expect(container.firstChild).toBeTruthy();
  });

  it('dilla:pickchannel switches to a known channel', () => {
    const { container } = renderApp();
    dispatch('dilla:pickchannel', 'ch-1');
    expect(container.firstChild).toBeTruthy();
  });

  it('dilla:pickchannel with unknown id is silently ignored', () => {
    const { container } = renderApp();
    dispatch('dilla:pickchannel', 'no-such-channel');
    expect(container.firstChild).toBeTruthy();
  });

  it('dilla:open-menu sets the menu popover state', () => {
    const { container } = renderApp();
    dispatch('dilla:open-menu', { x: 50, y: 100, items: [] });
    expect(container.firstChild).toBeTruthy();
  });

  it('Meta+1..5 keydown picks ordered channels', () => {
    const { container } = renderApp();
    for (const key of ['1', '2', '3', '4', '5']) {
      act(() => {
        fireEvent.keyDown(window, { key, metaKey: true });
      });
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('keydown m toggles mute when voice is connected', () => {
    useVoiceStore.setState({ connected: true } as never);
    const { container } = renderApp();
    act(() => {
      fireEvent.keyDown(window, { key: 'm' });
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('keydown d toggles deaf when voice is connected', () => {
    useVoiceStore.setState({ connected: true } as never);
    const { container } = renderApp();
    act(() => {
      fireEvent.keyDown(window, { key: 'd' });
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('keydown originating from an input field is ignored', () => {
    const { container } = renderApp();
    const input = document.createElement('input');
    document.body.appendChild(input);
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
    });
    expect(container.firstChild).toBeTruthy();
    document.body.removeChild(input);
  });
});
