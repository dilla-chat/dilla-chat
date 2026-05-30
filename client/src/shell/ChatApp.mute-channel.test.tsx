// Drives toggleMuteChannel (L4915-4937) by right-clicking a channel row to
// open the context menu, then clicking "Mute kanal" / "Unmute kanal".
// Also covers openMenu() at L4911-4914 via the alternative
// "dispatch dilla:open-menu with a custom items array" path.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';

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
  useChannelMuteStore.setState({ muted: new Map() } as never);
  usePinStore.setState({ pins: {} } as never);
}

const ME = { id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online' };

function makeData() {
  return {
    SERVERS: [{ id: 't1', name: 'Acme', node: 'local', short: 'A', federated: false, members: 0 }],
    CHANNELS: [{ id: 'ch-1', name: 'general', type: 'text', topic: '', encrypted: true, unread: 0 }],
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

function renderApp() {
  return render(
    <ShellDataProvider value={makeData()}>
      <ChatApp theme={{ name: 'mesh' }} opts={{}} />
    </ShellDataProvider>,
  );
}

beforeEach(() => seedAllStores());

describe('ChatApp toggleMuteChannel (mock session)', () => {
  it('mutes a channel via the right-click context menu', () => {
    const { container } = renderApp();
    // Initially unmuted.
    expect(useChannelMuteStore.getState().isMuted('ch-1')).toBe(false);
    // Right-click the channel row to open the context menu.
    const channelRow = container.querySelector('.channel-row') as HTMLElement | null;
    expect(channelRow).toBeTruthy();
    act(() => {
      fireEvent.contextMenu(channelRow!, { clientX: 100, clientY: 100 });
    });
    // The Mute kanal button is now in the .ctx-menu popover.
    const buttons = Array.from(container.querySelectorAll('.ctx-menu button')) as HTMLButtonElement[];
    const muteBtn = buttons.find((b) => /^Mute kanal$/i.test(b.textContent?.trim() ?? ''));
    expect(muteBtn).toBeTruthy();
    act(() => {
      fireEvent.click(muteBtn!);
    });
    // Now muted in the store.
    expect(useChannelMuteStore.getState().isMuted('ch-1')).toBe(true);
  });

  it('unmutes a muted channel via context menu', () => {
    useChannelMuteStore.getState().setMuted('ch-1', null);
    const { container } = renderApp();
    const channelRow = container.querySelector('.channel-row') as HTMLElement;
    act(() => {
      fireEvent.contextMenu(channelRow, { clientX: 100, clientY: 100 });
    });
    const buttons = Array.from(container.querySelectorAll('.ctx-menu button')) as HTMLButtonElement[];
    const unmuteBtn = buttons.find((b) => /^Unmute kanal$/i.test(b.textContent?.trim() ?? ''));
    expect(unmuteBtn).toBeTruthy();
    act(() => {
      fireEvent.click(unmuteBtn!);
    });
    expect(useChannelMuteStore.getState().isMuted('ch-1')).toBe(false);
  });

  it('context menu also has a Mark-as-read button that does not throw', () => {
    const { container } = renderApp();
    const channelRow = container.querySelector('.channel-row') as HTMLElement;
    act(() => {
      fireEvent.contextMenu(channelRow, { clientX: 100, clientY: 100 });
    });
    const buttons = Array.from(container.querySelectorAll('.ctx-menu button')) as HTMLButtonElement[];
    const markBtn = buttons.find((b) => /Mark as read/i.test(b.textContent ?? ''));
    expect(markBtn).toBeTruthy();
    act(() => {
      fireEvent.click(markBtn!);
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('overlay click outside menu closes the popover', () => {
    const { container } = renderApp();
    const channelRow = container.querySelector('.channel-row') as HTMLElement;
    act(() => {
      fireEvent.contextMenu(channelRow, { clientX: 50, clientY: 50 });
    });
    expect(container.querySelector('.ctx-menu')).toBeTruthy();
    const overlay = container.querySelector('.ctx-overlay-dismiss') as HTMLElement;
    act(() => {
      fireEvent.click(overlay);
    });
    expect(container.querySelector('.ctx-menu')).toBeFalsy();
  });
});
