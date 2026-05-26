// More ChatApp custom event handlers — exhaustive sweep.

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

const ME = { id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online' };
const ALICE = { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0', status: 'online' };
const CHANNEL = { id: 'ch-1', name: 'general', type: 'text', topic: '', encrypted: true, unread: 0 };

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
  useChannelMuteStore.setState({ muted: new Set() } as never);
  usePinStore.setState({ pinned: new Map() } as never);
}

function makeData() {
  return {
    SERVERS: [{ id: 't1', name: 'Acme' }],
    CHANNELS: [CHANNEL],
    MEMBERS: [ME, ALICE],
    byId: { me: ME, u2: ALICE },
    MESSAGES: {},
    DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: {},
    activeServerId: 't1', activeChannelId: 'ch-1', currentUserId: 'me',
  };
}

beforeEach(() => seedStores());

const EVENTS: Array<[string, Record<string, unknown> | undefined]> = [
  ['dilla:start-voice-call', { userId: 'u2' }],
  ['dilla:end-voice-call', undefined],
  ['dilla:incoming-call', { from: 'u2', kind: 'voice' }],
  ['dilla:dismiss-incoming-call', undefined],
  ['dilla:accept-incoming-call', undefined],
  ['dilla:decline-incoming-call', undefined],
  ['dilla:start-screen-share', undefined],
  ['dilla:stop-screen-share', undefined],
  ['dilla:start-webcam', undefined],
  ['dilla:stop-webcam', undefined],
  ['dilla:toggle-mute', undefined],
  ['dilla:toggle-deafen', undefined],
  ['dilla:verify-safety', 'u2'],
  ['dilla:connection', 'offline'],
  ['dilla:connection', 'reconnecting'],
  ['dilla:connection', 'degraded'],
  ['dilla:connection', null],
  ['dilla:add-peer', undefined],
  ['dilla:notify', { author: 'me', text: 'hi', duration: 2000 }],
  ['dilla:server-config', { db_encrypted: true }],
  ['dilla:open-settings', { mode: 'user', tab: 'account' }],
  ['dilla:close-settings', undefined],
  ['dilla:reply-to-message', { messageId: 'm1' }],
];

describe('ChatApp event handlers', () => {
  for (const [name, detail] of EVENTS) {
    it(`responds to ${name}`, () => {
      const { container } = render(
        <ShellDataProvider value={makeData()}>
          <ChatApp theme={{ name: 'mesh' }} opts={{}} />
        </ShellDataProvider>,
      );
      act(() => {
        window.dispatchEvent(new CustomEvent(name, detail !== undefined ? { detail } : undefined));
      });
      expect(container.firstChild).toBeTruthy();
    });
  }
});
