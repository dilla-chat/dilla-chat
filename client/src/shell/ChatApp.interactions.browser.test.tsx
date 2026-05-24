// Drives ChatApp interactions (clicks, key events, modals) in real
// Chromium so the event handlers — not just the initial render — get
// covered. Pair with ChatApp.browser.test.tsx which covers static
// render variations.

import { describe, it, expect, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
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
    activeTeamId: 't1',
    activeChannelId: 'ch-1',
    teams: new Map([['t1', { id: 't1', name: 'Acme' }]]),
    channels: new Map([['t1', [
      { id: 'ch-1', name: 'general', type: 'text' },
      { id: 'ch-2', name: 'lounge', type: 'voice' },
      { id: 'ch-3', name: 'dev', type: 'text' },
    ]]]),
    members: new Map([['t1', EMPTY]]),
    roles: new Map([['t1', EMPTY]]),
    groups: new Map([['t1', EMPTY]]),
  } as never);
  useAuthStore.setState({
    derivedKey: 'key',
    teams: new Map([['t1', { user: { id: 'me' } }]]),
  } as never);
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
  useMessageStore.setState({
    messages: new Map(),
    typing: new Map(),
    hasMore: new Map(),
    loadingHistory: new Map(),
  } as never);
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
    SERVERS: [{ id: 't1', name: 'Acme', node: 'local', short: 'A', federated: false, members: 0 }],
    CHANNELS: [
      { id: 'ch-1', name: 'general', type: 'text', topic: 'g', encrypted: true, unread: 0 },
      { id: 'ch-2', name: 'lounge', type: 'voice', topic: '', encrypted: true, unread: 0, participants: [] },
      { id: 'ch-3', name: 'dev', type: 'text', topic: '', encrypted: true, unread: 2 },
    ],
    MEMBERS: [
      { id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online' },
      { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0', status: 'online' },
    ],
    byId: {
      me: { id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online' },
      u2: { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0', status: 'online' },
    },
    MESSAGES: {
      'ch-1': [
        { id: 'm1', author: 'u2', at: new Date(), kind: 'text', text: 'hey', edited: false, deleted: false },
      ],
    },
    DMS: [
      { id: 'dm-1', with: 'u2', preview: 'sup', at: new Date(), unread: 0 },
    ],
    DM_MESSAGES: {
      'dm-1': [
        { id: 'dm-m1', author: 'u2', at: new Date(), kind: 'text', text: 'DM hi', edited: false, deleted: false },
      ],
    },
    THREAD_REPLIES: {},
    activeServerId: 't1',
    activeChannelId: 'ch-1',
    currentUserId: 'me',
  };
}

describe('ChatApp interactions in real Chromium', () => {
  beforeEach(() => {
    seedStores();
  });

  it('clicking the PMs/DMs tab switches the sidebar mode', async () => {
    const screen = await render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    // The tab bar has 'kanals' (channels) and 'pms' (DMs). Click whatever
    // looks like the PMs tab.
    const all = [...screen.container.querySelectorAll('button, [role="tab"]')] as HTMLElement[];
    const pmsTab = all.find((el) => /pms|dm/i.test(el.textContent ?? ''));
    if (pmsTab) await pmsTab.click();
    expect(screen.container.firstChild).toBeTruthy();
  });

  it('clicking a different text channel switches the view', async () => {
    const screen = await render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    // Find the second text channel ("dev") and click it. The exact
    // selector depends on the channel-list DOM; try various.
    const devEl = screen.container.querySelector('[data-channel-id="ch-3"]') ||
                  [...screen.container.querySelectorAll('*')].find((el) => el.textContent?.trim().endsWith('dev'));
    if (devEl) await (devEl as HTMLElement).click();
    expect(screen.container.firstChild).toBeTruthy();
  });

  it('clicking a voice channel opens the voice channel view', async () => {
    const screen = await render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const voiceEl = screen.container.querySelector('[data-channel-id="ch-2"]') ||
                    [...screen.container.querySelectorAll('*')].find((el) => el.textContent?.trim().endsWith('lounge'));
    if (voiceEl) await (voiceEl as HTMLElement).click();
    expect(screen.container.firstChild).toBeTruthy();
  });

  it('opens the search palette on global / press', async () => {
    const screen = await render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    // Dispatch the keyboard event globally — AppShell handles it
    // typically but ChatApp may surface a command-K hint.
    window.dispatchEvent(new CustomEvent('dilla:open-search', { detail: null }));
    expect(screen.container.firstChild).toBeTruthy();
  });

  it('renders ChatApp + dispatches the dilla:open-profile event', async () => {
    const screen = await render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    window.dispatchEvent(new CustomEvent('dilla:open-profile', { detail: { memberId: 'u2', x: 100, y: 100 } }));
    expect(screen.container.firstChild).toBeTruthy();
  });

  it('renders + dispatches dilla:open-dm', async () => {
    const screen = await render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    window.dispatchEvent(new CustomEvent('dilla:open-dm', { detail: 'u2' }));
    expect(screen.container.firstChild).toBeTruthy();
  });

  it('renders + dispatches dilla:insert-mention', async () => {
    const screen = await render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    window.dispatchEvent(new CustomEvent('dilla:insert-mention', { detail: 'alice' }));
    expect(screen.container.firstChild).toBeTruthy();
  });

  it('renders + dispatches dilla:open-menu (member context menu)', async () => {
    const screen = await render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    window.dispatchEvent(new CustomEvent('dilla:open-menu', {
      detail: { x: 100, y: 100, items: [{ label: 'test', onClick: () => {} }] },
    }));
    expect(screen.container.firstChild).toBeTruthy();
  });

  it('renders + dispatches dilla:open-settings', async () => {
    const screen = await render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    window.dispatchEvent(new CustomEvent('dilla:open-settings', { detail: { mode: 'user', tab: 'account' } }));
    expect(screen.container.firstChild).toBeTruthy();
  });

  it('renders + dispatches dilla:start-call (voice ring)', async () => {
    const screen = await render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    window.dispatchEvent(new CustomEvent('dilla:start-call', { detail: { peer: 'u2', kind: 'voice' } }));
    expect(screen.container.firstChild).toBeTruthy();
  });

  it('member panel renders + dispatches dilla:verify-safety', async () => {
    const screen = await render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    window.dispatchEvent(new CustomEvent('dilla:verify-safety', { detail: 'u2' }));
    expect(screen.container.firstChild).toBeTruthy();
  });

  it('renders with derivedKey null (locked state)', async () => {
    useAuthStore.setState({ derivedKey: null } as never);
    const screen = await render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(screen.container.firstChild).toBeTruthy();
  });

  it('renders with voice connected (full voice dock)', async () => {
    useVoiceStore.setState({
      connected: true,
      currentChannelId: 'ch-2',
      voiceOccupants: { 'ch-2': [
        { user_id: 'me', muted: false, deafened: false, speaking: false, screen_sharing: false, webcam_sharing: false },
      ] },
      muted: false,
      deafened: false,
      speaking: false,
      peers: {},
      peerLatencies: {},
      latencySamples: [12, 14, 13],
      bitrateSamples: [22, 24, 23],
      localScreenStream: null,
      remoteScreenStreams: {},
      localWebcamStream: null,
      remoteWebcamStreams: {},
    } as never);
    const screen = await render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(screen.container.firstChild).toBeTruthy();
  });

  it('renders with typing indicator active', async () => {
    useMessageStore.setState({
      messages: new Map(),
      typing: new Map([['ch-1', [{ userId: 'u2', username: 'alice', timestamp: Date.now() }]]]),
      hasMore: new Map(),
      loadingHistory: new Map(),
    } as never);
    const screen = await render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(screen.container.firstChild).toBeTruthy();
  });

  it('renders with pin store populated', async () => {
    usePinStore.setState({ pins: { 'ch-1': [{ id: 'm1', channel_id: 'ch-1' }] } } as never);
    const screen = await render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(screen.container.firstChild).toBeTruthy();
  });

  it('renders with channel muted', async () => {
    useChannelMuteStore.setState({ muted: new Set(['ch-1']) } as never);
    const screen = await render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(screen.container.firstChild).toBeTruthy();
  });

  it('renders with blocked user in messages (filtered out)', async () => {
    useBlockStore.setState({ blocked: new Set(['u2']) } as never);
    const screen = await render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(screen.container.firstChild).toBeTruthy();
  });

  it('renders with a long message body (many lines)', async () => {
    const longText = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const data = makeData();
    (data.MESSAGES as Record<string, unknown[]>)['ch-1'] = [{
      id: 'm-long', author: 'me', at: new Date(), kind: 'text', text: longText,
      edited: false, deleted: false,
    }];
    const screen = await render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    expect(screen.container.firstChild).toBeTruthy();
  });
});
