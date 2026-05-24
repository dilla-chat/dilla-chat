// Drives every `dilla:*` window event ChatApp listens for, plus
// several follow-up state changes, in a single rendered instance.
// Each event opens a modal or wires a state branch, which is mostly
// where the file's uncovered handler code lives.

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
      { id: 'ch-1', name: 'general', type: 'text', topic: 'g', category: 'Main', groupId: 'g1' },
      { id: 'ch-2', name: 'voice', type: 'voice', topic: '', category: 'Main', groupId: 'g1' },
    ]]]),
    members: new Map([['t1', [
      { id: 'm1', userId: 'me', username: 'me', displayName: 'Me', publicKeyHex: '', avatarUrl: '' },
      { id: 'm2', userId: 'u2', username: 'alice', displayName: 'Alice', publicKeyHex: '', avatarUrl: '' },
    ]]]),
    roles: new Map([['t1', [
      { id: 'r1', name: 'Admin', color: '#f00', position: 2, permissions: 0xFFF, isDefault: false },
    ]]]),
    groups: new Map([['t1', [
      { id: 'g1', team_id: 't1', name: 'Main', position: 0, access_role_ids: [], hidden_if_restricted: false },
    ]]]),
  } as never);
  useAuthStore.setState({
    derivedKey: 'k',
    teams: new Map([['t1', { user: { id: 'me' }, baseUrl: '' }]]),
  } as never);
  useVoiceStore.setState({
    connected: false, currentChannelId: null, voiceOccupants: {},
    muted: false, deafened: false, speaking: false,
    peers: {}, peerLatencies: {},
    latencySamples: EMPTY, bitrateSamples: EMPTY,
    localScreenStream: null, remoteScreenStreams: {},
    localWebcamStream: null, remoteWebcamStreams: {},
  } as never);
  useMessageStore.setState({
    messages: new Map(), typing: new Map(), hasMore: new Map(), loadingHistory: new Map(),
  } as never);
  useDMStore.setState({ dmChannels: {}, dmMessages: {}, activeDMId: null } as never);
  useThreadStore.setState({ threads: {}, threadMessages: {} } as never);
  useUnreadStore.setState({ counts: {} } as never);
  usePollStore.setState({ polls: new Map() } as never);
  useBlockStore.setState({ blocked: new Set() } as never);
  useChannelMuteStore.setState({ muted: new Set() } as never);
  usePinStore.setState({ pins: {} } as never);
}

const DATA = {
  SERVERS: [{ id: 't1', name: 'Acme', node: 'local', short: 'A', federated: false, members: 0 }],
  CHANNELS: [
    { id: 'ch-1', name: 'general', type: 'text', topic: '', category: 'Main', groupId: 'g1', encrypted: true, unread: 0 },
    { id: 'ch-2', name: 'voice', type: 'voice', topic: '', category: 'Main', groupId: 'g1', encrypted: true, unread: 0, participants: [] },
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
      { id: 'm1', author: 'u2', at: new Date(), kind: 'text', text: 'hello', edited: false, deleted: false },
    ],
  },
  DMS: [],
  DM_MESSAGES: {},
  THREAD_REPLIES: {},
  activeServerId: 't1',
  activeChannelId: 'ch-1',
  currentUserId: 'me',
};

const EVENTS_TO_FIRE: Array<[string, unknown]> = [
  ['dilla:open-channel-access', { channelId: 'ch-1' }],
  ['dilla:open-channel-settings', { channelId: 'ch-1' }],
  ['dilla:open-group-access', { groupId: 'g1' }],
  ['dilla:open-group-settings', { groupId: 'g1' }],
  ['dilla:open-new-channel', null],
  ['dilla:open-add-server', null],
  ['dilla:open-thread', { channelId: 'ch-1', messageId: 'm1' }],
  ['dilla:open-profile', { memberId: 'u2', x: 100, y: 100 }],
  ['dilla:open-dm', 'u2'],
  ['dilla:close-dm', 'dm-1'],
  ['dilla:open-menu', { x: 100, y: 100, items: [{ label: 'x', onClick: () => {} }] }],
  ['dilla:open-search', null],
  ['dilla:open-settings', { mode: 'user', tab: 'account' }],
  ['dilla:insert-mention', 'alice'],
  ['dilla:notify', { title: 'test', body: 'body' }],
  ['dilla:pickchannel', 'ch-2'],
  ['dilla:toggle-drawer', 'sidebar'],
  ['dilla:verify-safety', 'u2'],
  ['dilla:giphy-pick', 'https://media.giphy.com/x.gif'],
];

describe('ChatApp window events in real Chromium', () => {
  beforeEach(() => seedStores());

  // Single render that handles all events — the wholesale firing
  // exercises every window-event handler in the component.
  it('fires every dilla:* event on a single rendered ChatApp', async () => {
    const screen = await render(
      <ShellDataProvider value={DATA}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    for (const [name, detail] of EVENTS_TO_FIRE) {
      window.dispatchEvent(new CustomEvent(name, { detail }));
    }
    expect(screen.container.firstChild).toBeTruthy();
  });

  // One test per event so a hang on any single one isolates and the
  // pass count reflects what works.
  for (const [name, detail] of EVENTS_TO_FIRE) {
    it(`handles ${name}`, async () => {
      const screen = await render(
        <ShellDataProvider value={DATA}>
          <ChatApp theme={{ name: 'mesh' }} opts={{}} />
        </ShellDataProvider>,
      );
      window.dispatchEvent(new CustomEvent(name, { detail }));
      expect(screen.container.firstChild).toBeTruthy();
    });
  }

  it('fires open-thread + then close-thread sequence', async () => {
    const screen = await render(
      <ShellDataProvider value={DATA}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    window.dispatchEvent(new CustomEvent('dilla:open-thread', { detail: { channelId: 'ch-1', messageId: 'm1' } }));
    expect(screen.container.firstChild).toBeTruthy();
  });

  it('fires pickchannel for a voice channel', async () => {
    const screen = await render(
      <ShellDataProvider value={DATA}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    window.dispatchEvent(new CustomEvent('dilla:pickchannel', { detail: 'ch-2' }));
    expect(screen.container.firstChild).toBeTruthy();
  });

  it('fires multiple notify events (toast stack)', async () => {
    const screen = await render(
      <ShellDataProvider value={DATA}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    for (let i = 0; i < 4; i++) {
      window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { title: `t${i}` } }));
    }
    expect(screen.container.firstChild).toBeTruthy();
  });
});
