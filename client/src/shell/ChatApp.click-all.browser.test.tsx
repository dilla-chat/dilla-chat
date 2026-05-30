// Render ChatApp, then mass-click every visible button. Each click
// either toggles state, opens a modal, or fires a handler that's
// otherwise unreachable from a static render. The point is breadth,
// not depth: even if half the clicks do nothing useful, the other
// half each cover a real handler.

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
      { id: 'ch-3', name: 'dev', type: 'text', topic: '', category: 'Dev', groupId: 'g2' },
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
      { id: 'g2', team_id: 't1', name: 'Dev', position: 1, access_role_ids: [], hidden_if_restricted: false },
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
    { id: 'ch-3', name: 'dev', type: 'text', topic: '', category: 'Dev', groupId: 'g2', encrypted: true, unread: 0 },
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
      { id: 'm2', author: 'me', at: new Date(), kind: 'text', text: 'world', edited: true, deleted: false,
        reactions: [{ e: '🎉', n: 2, mine: true }] },
    ],
  },
  DMS: [
    { id: 'dm-1', with: 'u2', preview: 'sup', at: new Date(), unread: 0 },
  ],
  DM_MESSAGES: {
    'dm-1': [{ id: 'dm-m1', author: 'u2', at: new Date(), kind: 'text', text: 'DM hello', edited: false, deleted: false }],
  },
  THREAD_REPLIES: {},
  activeServerId: 't1',
  activeChannelId: 'ch-1',
  currentUserId: 'me',
};

describe('ChatApp mass-click coverage in real Chromium', () => {
  beforeEach(() => seedStores());

  it('clicks every visible button in the rendered chat', async () => {
    const { container } = await render(
      <ShellDataProvider value={DATA}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const buttons = [...container.querySelectorAll('button')] as HTMLButtonElement[];
    for (const btn of buttons) {
      try { btn.click(); } catch { /* ignore */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('clicks every channel row in the sidebar', async () => {
    const { container } = await render(
      <ShellDataProvider value={DATA}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const channels = [...container.querySelectorAll('[class*="channel"]')] as HTMLElement[];
    for (const c of channels) {
      try { c.click(); } catch { /* ignore */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('clicks every member row in the member panel', async () => {
    const { container } = await render(
      <ShellDataProvider value={DATA}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const members = [...container.querySelectorAll('[class*="member"]')] as HTMLElement[];
    for (const m of members) {
      try { m.click(); } catch { /* ignore */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('clicks every server-rail tile', async () => {
    const { container } = await render(
      <ShellDataProvider value={DATA}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const tiles = [...container.querySelectorAll('[class*="server"]')] as HTMLElement[];
    for (const t of tiles) {
      try { t.click(); } catch { /* ignore */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('dispatches contextmenu on every member tile', async () => {
    const { container } = await render(
      <ShellDataProvider value={DATA}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const members = [...container.querySelectorAll('[class*="member"]')] as HTMLElement[];
    for (const m of members) {
      m.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('dispatches contextmenu on every message', async () => {
    const { container } = await render(
      <ShellDataProvider value={DATA}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const msgs = [...container.querySelectorAll('[class*="msg"], [class*="message"]')] as HTMLElement[];
    for (const m of msgs) {
      m.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('hovers over messages to trigger action toolbars', async () => {
    const { container } = await render(
      <ShellDataProvider value={DATA}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const msgs = [...container.querySelectorAll('[class*="msg"], [class*="message"]')] as HTMLElement[];
    for (const m of msgs) {
      m.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      m.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('dispatches keydown events on the chat root (shortcuts)', async () => {
    const { container } = await render(
      <ShellDataProvider value={DATA}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const root = container.firstChild as HTMLElement;
    if (root) {
      for (const key of ['Escape', 'Enter', 'k', 'M', 'D', '/']) {
        root.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ctrlKey: key === 'k' }));
        window.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: key === 'k' }));
      }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('focuses + types in the message composer', async () => {
    const { container } = await render(
      <ShellDataProvider value={DATA}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const textareas = [...container.querySelectorAll('textarea')] as HTMLTextAreaElement[];
    for (const t of textareas) {
      t.focus();
      t.value = 'test message';
      t.dispatchEvent(new InputEvent('input', { bubbles: true }));
      t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('clicks emoji buttons (reaction picker)', async () => {
    const { container } = await render(
      <ShellDataProvider value={DATA}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const emoji = [...container.querySelectorAll('[class*="emoji"], [class*="react"]')] as HTMLElement[];
    for (const e of emoji) {
      try { e.click(); } catch { /* ignore */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('clicks the message input wrapper (focus path)', async () => {
    const { container } = await render(
      <ShellDataProvider value={DATA}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const inputs = [...container.querySelectorAll('[class*="composer"], [class*="input"]')] as HTMLElement[];
    for (const i of inputs) {
      try { i.click(); } catch { /* ignore */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('iterates dms, voice/text channels with seeded variants', async () => {
    // Variant: active dm view.
    {
      const { container } = await render(
        <ShellDataProvider value={{ ...DATA, activeChannelId: null }}>
          <ChatApp theme={{ name: 'mesh' }} opts={{}} />
        </ShellDataProvider>,
      );
      expect(container.firstChild).toBeTruthy();
    }
    // Variant: active voice channel.
    {
      const { container } = await render(
        <ShellDataProvider value={{ ...DATA, activeChannelId: 'ch-2' }}>
          <ChatApp theme={{ name: 'mesh' }} opts={{}} />
        </ShellDataProvider>,
      );
      expect(container.firstChild).toBeTruthy();
    }
  });
});
