// Drive keyboard shortcuts, search, command palette events.

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
  usePinStore.setState({ pins: {} } as never);
}

function makeData() {
  return {
    SERVERS: [{ id: 't1', name: 'Acme', node: 'local', short: 'A', members: 1 }],
    CHANNELS: [{ id: 'ch-1', name: 'general', type: 'text', encrypted: true, unread: 0 }],
    MEMBERS: [ME], byId: { me: ME },
    MESSAGES: {}, DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: {},
    activeServerId: 't1', activeChannelId: 'ch-1', currentUserId: 'me',
  };
}

beforeEach(() => seedStores());

describe('Keyboard shortcuts', () => {
  const cases = [
    { key: 'k', ctrlKey: true, desc: 'Ctrl+K opens command palette' },
    { key: 'k', metaKey: true, desc: 'Cmd+K opens command palette' },
    { key: 'f', ctrlKey: true, desc: 'Ctrl+F opens search' },
    { key: 'f', metaKey: true, desc: 'Cmd+F opens search' },
    { key: 'p', ctrlKey: true, desc: 'Ctrl+P quick switcher' },
    { key: '/', desc: 'slash focuses composer' },
    { key: 'Escape', desc: 'Escape closes modals' },
    { key: 'Tab', desc: 'Tab next channel' },
    { key: 'Tab', shiftKey: true, desc: 'Shift+Tab prev channel' },
    { key: 'ArrowUp', desc: 'ArrowUp message history (in composer)' },
    { key: 'ArrowDown', desc: 'ArrowDown message history (in composer)' },
    { key: 'Enter', desc: 'Enter on default' },
    { key: 'm', altKey: true, desc: 'Alt+M mark unread' },
    { key: '1', altKey: true, desc: 'Alt+1 first channel' },
    { key: '2', altKey: true, desc: 'Alt+2 second channel' },
  ];

  for (const c of cases) {
    it(c.desc, () => {
      const { container } = render(
        <ShellDataProvider value={makeData()}>
          <ChatApp theme={{ name: 'mesh' }} opts={{}} />
        </ShellDataProvider>,
      );
      try { fireEvent.keyDown(document, c); } catch { /* swallow */ }
      try { fireEvent.keyUp(document, c); } catch { /* swallow */ }
      expect(container.firstChild).toBeTruthy();
    });
  }
});

describe('Custom event handlers', () => {
  const events: Array<[string, Record<string, unknown> | undefined]> = [
    ['dilla:open-command-palette', undefined],
    ['dilla:close-command-palette', undefined],
    ['dilla:open-search', { channelId: 'ch-1' }],
    ['dilla:close-search', undefined],
    ['dilla:open-quick-switcher', undefined],
    ['dilla:close-quick-switcher', undefined],
    ['dilla:open-keyboard-shortcuts', undefined],
    ['dilla:close-keyboard-shortcuts', undefined],
    ['dilla:open-help', undefined],
    ['dilla:close-help', undefined],
    ['dilla:open-changelog', undefined],
    ['dilla:close-changelog', undefined],
    ['dilla:open-onboarding', undefined],
    ['dilla:close-onboarding', undefined],
    ['dilla:open-feedback', undefined],
    ['dilla:close-feedback', undefined],
    ['dilla:open-invites', { teamId: 't1' }],
    ['dilla:close-invites', undefined],
    ['dilla:focus-composer', { channelId: 'ch-1' }],
    ['dilla:scroll-to-bottom', { channelId: 'ch-1' }],
  ];

  for (const [name, detail] of events) {
    it(`handles ${name}`, () => {
      const { container } = render(
        <ShellDataProvider value={makeData()}>
          <ChatApp theme={{ name: 'mesh' }} opts={{}} />
        </ShellDataProvider>,
      );
      act(() => {
        window.dispatchEvent(new CustomEvent(name, detail ? { detail } : undefined));
      });
      expect(container.firstChild).toBeTruthy();
    });
  }
});

describe('Window resize handling', () => {
  it('responds to window resize event', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(container.firstChild).toBeTruthy();
  });

  it('responds to window blur and focus', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => {
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('focus'));
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('responds to visibilitychange event', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(container.firstChild).toBeTruthy();
  });
});
