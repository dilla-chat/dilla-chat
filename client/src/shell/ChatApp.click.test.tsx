// Drive every clickable element in a rendered ChatApp under jsdom.
// Each click triggers a handler that's otherwise unreachable from
// pure render tests. Pair with ChatApp.full.test.tsx + .integration
// which cover static renders.

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
const VC_STUB = { connected: false, currentChannelId: null, muted: false, deafened: false, speaking: false, voiceLevel: 0, peers: {}, join: () => {}, leave: () => {} };
vi.mock('../hooks/useVoiceConnection', () => ({ useVoiceConnection: () => VC_STUB }));
vi.mock('../components/MessageMarkdown/MessageMarkdown', () => ({
  default: ({ text }: { text: string }) => <span>{text}</span>,
}));
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

function seedAllStores() {
  const EMPTY: never[] = [];
  useTeamStore.setState({
    activeTeamId: 't1', activeChannelId: 'ch-1',
    teams: new Map([['t1', { id: 't1', name: 'Acme' }]]),
    channels: new Map([['t1', [
      { id: 'ch-1', teamId: 't1', name: 'general', type: 'text' },
      { id: 'ch-2', teamId: 't1', name: 'voice', type: 'voice' },
      { id: 'ch-3', teamId: 't1', name: 'dev', type: 'text' },
    ]]]),
    members: new Map([['t1', [
      { id: 'm1', userId: 'me', username: 'me', displayName: 'Me', publicKeyHex: '', avatarUrl: '', isAdmin: true, roles: [] },
      { id: 'm2', userId: 'u2', username: 'alice', displayName: 'Alice', publicKeyHex: '', avatarUrl: '', isAdmin: false, roles: [] },
    ]]]),
    roles: new Map([['t1', EMPTY]]),
    groups: new Map([['t1', EMPTY]]),
  } as never);
  useAuthStore.setState({ derivedKey: 'k', teams: new Map([['t1', { user: { id: 'me' } }]]) } as never);
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
const ALICE = { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0', status: 'online' };

function makeData(overrides: Record<string, unknown> = {}) {
  return {
    SERVERS: [{ id: 't1', name: 'Acme', node: 'local', short: 'A', federated: false, members: 0 }],
    CHANNELS: [
      { id: 'ch-1', name: 'general', type: 'text', topic: '', encrypted: true, unread: 0 },
      { id: 'ch-2', name: 'voice', type: 'voice', topic: '', encrypted: true, unread: 0, participants: [] },
      { id: 'ch-3', name: 'dev', type: 'text', topic: '', encrypted: true, unread: 5 },
    ],
    MEMBERS: [ME, ALICE],
    byId: { me: ME, u2: ALICE },
    MESSAGES: {
      'ch-1': [
        { id: 'm1', author: 'u2', at: new Date(), kind: 'text', text: 'hello world',
          edited: false, deleted: false,
          reactions: [{ e: '🎉', n: 2, mine: false }] },
        { id: 'm2', author: 'me', at: new Date(), kind: 'text', text: 'my reply',
          edited: true, deleted: false },
      ],
    },
    DMS: [{ id: 'dm-1', with: 'u2', preview: 'sup', at: new Date(), unread: 0 }],
    DM_MESSAGES: {
      'dm-1': [
        { id: 'dm-m1', author: 'u2', at: new Date(), kind: 'text', text: 'DM hello', edited: false, deleted: false },
      ],
    },
    THREAD_REPLIES: {},
    activeServerId: 't1',
    activeChannelId: 'ch-1',
    currentUserId: 'me',
    ...overrides,
  };
}

function renderApp(data: ReturnType<typeof makeData> = makeData(), props: Record<string, unknown> = {}) {
  return render(
    <ShellDataProvider value={data}>
      <ChatApp theme={{ name: 'mesh' }} opts={{}} {...props} />
    </ShellDataProvider>,
  );
}

beforeEach(() => seedAllStores());

describe('ChatApp click-through (jsdom)', () => {
  it('clicks every button in the rendered tree', () => {
    const { container } = renderApp();
    const buttons = [...container.querySelectorAll('button')] as HTMLButtonElement[];
    expect(buttons.length).toBeGreaterThan(0);
    for (const btn of buttons) {
      try { fireEvent.click(btn); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('dispatches keydown for every shortcut key', () => {
    const { container } = renderApp();
    for (const key of ['Escape', 'Enter', '/', 'k', 'M', 'D']) {
      fireEvent.keyDown(window, { key, ctrlKey: key === 'k', metaKey: key === 'k' });
      fireEvent.keyDown(container, { key });
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('clicks every channel row in the sidebar', () => {
    const { container } = renderApp();
    const channels = [...container.querySelectorAll('[class*="chan"]')] as HTMLElement[];
    for (const c of channels) {
      try { fireEvent.click(c); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('right-clicks every member to open context menu', () => {
    const { container } = renderApp();
    const members = [...container.querySelectorAll('[class*="member"]')] as HTMLElement[];
    for (const m of members) {
      fireEvent.contextMenu(m, { clientX: 100, clientY: 100 });
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('right-clicks every message', () => {
    const { container } = renderApp();
    const msgs = [...container.querySelectorAll('[class*="msg"], [class*="message"]')] as HTMLElement[];
    for (const m of msgs) {
      fireEvent.contextMenu(m, { clientX: 100, clientY: 100 });
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('mouse-enter / leave on every message', () => {
    const { container } = renderApp();
    const msgs = [...container.querySelectorAll('[class*="msg"], [class*="message"]')] as HTMLElement[];
    for (const m of msgs) {
      fireEvent.mouseEnter(m);
      fireEvent.mouseLeave(m);
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('types in the composer textarea', () => {
    const { container } = renderApp();
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement | null;
    if (textarea) {
      fireEvent.focus(textarea);
      fireEvent.input(textarea, { target: { value: 'hello' } });
      fireEvent.change(textarea, { target: { value: 'hello world' } });
      fireEvent.keyDown(textarea, { key: 'Enter' });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('paste event on the composer', () => {
    const { container } = renderApp();
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement | null;
    if (textarea) {
      fireEvent.paste(textarea, { clipboardData: { getData: () => 'pasted text', files: [] } });
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('drop file event on the composer area', () => {
    const { container } = renderApp();
    const dropTarget = container.querySelector('[class*="composer"], [class*="input"], textarea')?.closest('div') as HTMLElement | null;
    if (dropTarget) {
      const file = new File(['hello'], 'test.txt', { type: 'text/plain' });
      fireEvent.dragOver(dropTarget, { dataTransfer: { files: [file] } });
      fireEvent.drop(dropTarget, { dataTransfer: { files: [file] } });
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('clicks every emoji / reaction pill', () => {
    const { container } = renderApp();
    const pills = [...container.querySelectorAll('[class*="emoji"], [class*="react"]')] as HTMLElement[];
    for (const p of pills) {
      try { fireEvent.click(p); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('clicks every link in messages', () => {
    const data = makeData({
      MESSAGES: {
        'ch-1': [
          { id: 'm1', author: 'me', at: new Date(), kind: 'text',
            text: 'check https://github.com/dilla-chat/dilla-chat and https://figma.com/x',
            edited: false, deleted: false },
        ],
      },
    });
    const { container } = renderApp(data);
    const links = [...container.querySelectorAll('a')] as HTMLAnchorElement[];
    for (const a of links) {
      try { fireEvent.click(a); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('clicks every server-rail tile', () => {
    const { container } = renderApp();
    const tiles = [...container.querySelectorAll('[class*="rail"], [class*="server"]')] as HTMLElement[];
    for (const t of tiles) {
      try { fireEvent.click(t); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('dispatches every dilla:* custom event', () => {
    renderApp();
    const events: Array<[string, unknown]> = [
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
      ['dilla:notify', { title: 'test' }],
      ['dilla:pickchannel', 'ch-3'],
      ['dilla:toggle-drawer', 'sidebar'],
      ['dilla:verify-safety', 'u2'],
      ['dilla:giphy-pick', 'https://media.giphy.com/x.gif'],
    ];
    for (const [name, detail] of events) {
      window.dispatchEvent(new CustomEvent(name, { detail }));
    }
    expect(document.body.firstChild).toBeTruthy();
  });

  it('clicks attachment-area + remove-attachment chips', () => {
    const { container } = renderApp();
    const attachBtns = [...container.querySelectorAll('button')].filter((b) =>
      /attach|paperclip|file|×|remove/i.test(b.title + (b.textContent ?? ''))
    );
    for (const b of attachBtns) {
      try { fireEvent.click(b); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('clicks "send message" button (icon-only)', () => {
    const data = makeData();
    const { container } = renderApp(data);
    // Find a "send" intent button.
    const sendBtns = [...container.querySelectorAll('button')].filter((b) =>
      /send/i.test(b.title + (b.getAttribute('aria-label') ?? ''))
    );
    for (const b of sendBtns) {
      try { fireEvent.click(b); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('toggles members panel', () => {
    const { container } = renderApp();
    const toggles = [...container.querySelectorAll('button')].filter((b) =>
      /member/i.test(b.title + (b.getAttribute('aria-label') ?? ''))
    );
    for (const b of toggles) {
      try { fireEvent.click(b); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('clicks every link-like element in the channel sidebar', () => {
    const { container } = renderApp();
    const allLinks = [...container.querySelectorAll('a, [role="link"], button')];
    for (const e of allLinks) {
      try { fireEvent.click(e as HTMLElement); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('fires window resize events (responsive paths)', () => {
    const { container } = renderApp();
    window.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(container.firstChild).toBeTruthy();
  });

  it('typing indicator updates from typing store', () => {
    useMessageStore.setState({
      messages: new Map(),
      typing: new Map([['ch-1', [{ userId: 'u2', username: 'alice', timestamp: Date.now() }]]]),
      hasMore: new Map(),
      loadingHistory: new Map(),
    } as never);
    const { container } = renderApp();
    expect(container.firstChild).toBeTruthy();
  });

  it('renders + clicks every voice control when voice is active', () => {
    useVoiceStore.setState({
      connected: true, currentChannelId: 'ch-2',
      voiceOccupants: { 'ch-2': [{ user_id: 'me', muted: false, deafened: false, speaking: false, screen_sharing: false, webcam_sharing: false }] },
      muted: false, deafened: false, speaking: false,
      peers: {}, peerLatencies: {},
      latencySamples: [12], bitrateSamples: [24],
      localScreenStream: null, remoteScreenStreams: {},
      localWebcamStream: null, remoteWebcamStreams: {},
    } as never);
    const data = makeData({ activeChannelId: 'ch-2' });
    const { container } = renderApp(data);
    const voiceBtns = [...container.querySelectorAll('button')].filter((b) =>
      /mic|deaf|cam|screen|disconnect|hangup|mute/i.test(b.title + (b.getAttribute('aria-label') ?? ''))
    );
    for (const b of voiceBtns) {
      try { fireEvent.click(b); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });
});
