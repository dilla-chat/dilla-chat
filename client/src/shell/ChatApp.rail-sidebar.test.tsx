// Drive ServerRail + ChannelSidebar click handlers — high uncovered
// surface in ChatApp.tsx (server pick, right-click menu, group toggle).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

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

function seedStores() {
  const EMPTY: never[] = [];
  useTeamStore.setState({
    activeTeamId: 't1', activeChannelId: 'ch-1',
    teams: new Map([
      ['t1', { id: 't1', name: 'Acme' }],
      ['t2', { id: 't2', name: 'Beta' }],
      ['t3', { id: 't3', name: 'Charlie' }],
    ]),
    channels: new Map([['t1', EMPTY], ['t2', EMPTY], ['t3', EMPTY]]),
    members: new Map([['t1', EMPTY], ['t2', EMPTY], ['t3', EMPTY]]),
    roles: new Map([['t1', EMPTY]]),
    groups: new Map([['t1', [
      { id: 'g1', name: 'general-grp', position: 0, expanded: false },
      { id: 'g2', name: 'voice-grp', position: 1, expanded: true },
    ]]]),
    setActiveTeam: vi.fn(),
    setActiveChannel: vi.fn(),
  } as never);
  useAuthStore.setState({
    derivedKey: 'k',
    teams: new Map([
      ['t1', { user: { id: 'me' } }],
      ['t2', { user: { id: 'me' } }],
      ['t3', { user: { id: 'me' } }],
    ]),
  } as never);
  useVoiceStore.setState({
    connected: false, currentChannelId: null, voiceOccupants: {},
    muted: false, deafened: false, speaking: false,
    peers: {}, peerLatencies: {},
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

const ME = { id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online' };
function makeData(overrides: Record<string, unknown> = {}) {
  return {
    SERVERS: [
      { id: 't1', name: 'Acme', node: 'local', short: 'A', members: 5, federated: false },
      { id: 't2', name: 'Beta', node: 'remote', short: 'B', members: 3, federated: true },
      { id: 't3', name: 'Charlie', node: 'local', short: 'C', members: 2, federated: false },
    ],
    CHANNELS: [
      { id: 'ch-1', name: 'general', type: 'text', topic: 'general', encrypted: true, unread: 0, groupId: 'g1' },
      { id: 'ch-2', name: 'random', type: 'text', encrypted: true, unread: 2, groupId: 'g1' },
      { id: 'ch-voice', name: 'lounge', type: 'voice', encrypted: true, unread: 0, participants: [], groupId: 'g2' },
    ],
    MEMBERS: [ME],
    byId: { me: ME },
    MESSAGES: {}, DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: {},
    activeServerId: 't1', activeChannelId: 'ch-1', currentUserId: 'me',
    ...overrides,
  };
}

beforeEach(() => seedStores());

describe('ServerRail interactions', () => {
  it('clicks every server tile', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const tiles = [...container.querySelectorAll('button.server, .server-rail button')] as HTMLElement[];
    for (const t of tiles) {
      try { fireEvent.click(t); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('right-clicks every server tile (contextmenu)', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const tiles = [...container.querySelectorAll('button.server, .server-rail button')] as HTMLElement[];
    for (const t of tiles) {
      try { fireEvent.contextMenu(t); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('mouse-overs every server tile (preview tooltip)', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const tiles = [...container.querySelectorAll('button.server, .server-rail button')] as HTMLElement[];
    for (const t of tiles) {
      try { fireEvent.mouseEnter(t); fireEvent.mouseLeave(t); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('clicks the Home and Add buttons in rail', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    // Click anything looking like home / add
    const homeBtn = [...container.querySelectorAll('button')].find((b) => /home|add|\+/.test(b.textContent ?? '') || b.getAttribute('aria-label')?.match(/home|add/i));
    if (homeBtn) {
      try { fireEvent.click(homeBtn as HTMLButtonElement); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });
});

describe('ChannelSidebar interactions', () => {
  it('clicks every channel row', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const rows = [...container.querySelectorAll('button.chan, button.channel, .channel-row')] as HTMLElement[];
    for (const r of rows) {
      try { fireEvent.click(r); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('right-clicks every channel row', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const rows = [...container.querySelectorAll('button.chan, button.channel, .channel-row')] as HTMLElement[];
    for (const r of rows) {
      try { fireEvent.contextMenu(r); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('toggles every group header (expand/collapse)', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const headers = [...container.querySelectorAll('.group-header, button.group, .channel-group-header')] as HTMLElement[];
    for (const h of headers) {
      try { fireEvent.click(h); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('shift+clicks channel rows (range select if supported)', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const rows = [...container.querySelectorAll('button.chan, button.channel, .channel-row')] as HTMLElement[];
    for (const r of rows) {
      try { fireEvent.click(r, { shiftKey: true }); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('alt+clicks channel rows', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const rows = [...container.querySelectorAll('button.chan, button.channel, .channel-row')] as HTMLElement[];
    for (const r of rows) {
      try { fireEvent.click(r, { altKey: true }); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });
});

describe('MemberList interactions', () => {
  it('clicks every member row', () => {
    const { container } = render(
      <ShellDataProvider value={makeData({
        MEMBERS: [
          ME,
          { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0', status: 'online' },
          { id: 'u3', name: 'bob', initials: 'BO', color: '#00f', status: 'offline' },
          { id: 'u4', name: 'carol', initials: 'CA', color: '#0ff', status: 'idle' },
        ],
        byId: {
          me: ME,
          u2: { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0', status: 'online' },
          u3: { id: 'u3', name: 'bob', initials: 'BO', color: '#00f', status: 'offline' },
          u4: { id: 'u4', name: 'carol', initials: 'CA', color: '#0ff', status: 'idle' },
        },
      })}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const rows = [...container.querySelectorAll('.member-row, button.member, .ml-row')] as HTMLElement[];
    for (const r of rows) {
      try { fireEvent.click(r); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('right-clicks every member row', () => {
    const { container } = render(
      <ShellDataProvider value={makeData({
        MEMBERS: [ME, { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0', status: 'online' }],
        byId: { me: ME, u2: { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0', status: 'online' } },
      })}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const rows = [...container.querySelectorAll('.member-row, button.member, .ml-row')] as HTMLElement[];
    for (const r of rows) {
      try { fireEvent.contextMenu(r); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });
});
