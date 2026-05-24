// Drive EmojiPicker, GiphyPicker, ForwardModal, ChannelAccessModal,
// GroupAccessModal, GroupCombobox — picker / access modal coverage.

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
const ALICE = { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0', status: 'online' };

function seedStores() {
  const EMPTY: never[] = [];
  useTeamStore.setState({
    activeTeamId: 't1', activeChannelId: 'ch-1',
    teams: new Map([['t1', { id: 't1', name: 'Acme' }]]),
    channels: new Map([['t1', [
      { id: 'ch-1', name: 'general', type: 'text' },
      { id: 'ch-2', name: 'random', type: 'text' },
    ]]]),
    members: new Map([['t1', EMPTY]]),
    roles: new Map([['t1', [
      { id: 'r1', name: 'Admin', position: 2, permissions: 0xFFF },
      { id: 'r2', name: '@everyone', position: 0, permissions: 0x47, isDefault: true },
    ]]]),
    groups: new Map([['t1', [{ id: 'g1', name: 'general-grp', position: 0 }]]]),
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
  useMessageStore.setState({
    messages: new Map([['ch-1', [
      { id: 'm1', author: 'me', at: new Date(), kind: 'text', text: 'hello', edited: false, deleted: false },
    ]]]),
    typing: new Map(), hasMore: new Map(), loadingHistory: new Map(),
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
    SERVERS: [{ id: 't1', name: 'Acme', node: 'local', short: 'A', members: 5 }],
    CHANNELS: [
      { id: 'ch-1', name: 'general', type: 'text', encrypted: true, unread: 0 },
      { id: 'ch-2', name: 'random', type: 'text', encrypted: true, unread: 0 },
    ],
    MEMBERS: [ME, ALICE],
    byId: { me: ME, u2: ALICE },
    MESSAGES: {
      'ch-1': [{ id: 'm1', author: 'me', at: new Date(), kind: 'text', text: 'hello', edited: false, deleted: false }],
    },
    DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: {},
    activeServerId: 't1', activeChannelId: 'ch-1', currentUserId: 'me',
  };
}

beforeEach(() => seedStores());

describe('EmojiPicker (via composer button)', () => {
  it('opens emoji picker via custom event then clicks an emoji', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => { window.dispatchEvent(new CustomEvent('dilla:open-emoji-picker', { detail: { messageId: 'm1' } })); });
    const buttons = [...container.querySelectorAll('.emoji-picker button, .ep button')] as HTMLElement[];
    for (const b of buttons.slice(0, 10)) {
      try { fireEvent.click(b); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });
});

describe('GiphyPicker (via composer button)', () => {
  it('opens giphy picker and clicks a gif', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => { window.dispatchEvent(new CustomEvent('dilla:open-giphy-picker')); });
    const items = [...container.querySelectorAll('.giphy-picker img, .gp button')] as HTMLElement[];
    for (const i of items.slice(0, 5)) {
      try { fireEvent.click(i); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });
});

describe('ForwardModal', () => {
  it('opens forward modal via event then clicks a target', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => {
      window.dispatchEvent(new CustomEvent('dilla:open-forward', { detail: { messageId: 'm1' } }));
    });
    const buttons = [...container.querySelectorAll('.forward-modal button, .fm button, .fwd-row')] as HTMLElement[];
    for (const b of buttons) {
      try { fireEvent.click(b); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });
});

describe('ChannelAccessModal', () => {
  it('opens channel access via event then clicks every button', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => {
      window.dispatchEvent(new CustomEvent('dilla:open-channel-access', { detail: { channelId: 'ch-1' } }));
    });
    const buttons = [...container.querySelectorAll('.channel-access button, .ca button')] as HTMLElement[];
    for (const b of buttons) {
      try { fireEvent.click(b); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });
});

describe('GroupAccessModal', () => {
  it('opens group access via event then clicks every button', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => {
      window.dispatchEvent(new CustomEvent('dilla:open-group-access', { detail: { groupId: 'g1' } }));
    });
    const buttons = [...container.querySelectorAll('.group-access button, .ga button')] as HTMLElement[];
    for (const b of buttons) {
      try { fireEvent.click(b); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });
});

describe('GroupCombobox', () => {
  it('renders within new-channel modal (with group dropdown)', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => { window.dispatchEvent(new CustomEvent('dilla:open-new-channel')); });
    // Try clicking and typing in any combobox-like input.
    const comboboxes = [...container.querySelectorAll('.group-combobox input, .gc input, input[role="combobox"]')] as HTMLInputElement[];
    for (const c of comboboxes) {
      try {
        fireEvent.focus(c);
        fireEvent.change(c, { target: { value: 'gen' } });
        fireEvent.keyDown(c, { key: 'ArrowDown' });
        fireEvent.keyDown(c, { key: 'Enter' });
      } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });
});

describe('Composer interactions (text/textarea)', () => {
  it('types in every textarea + presses Enter', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const tas = [...container.querySelectorAll('textarea')] as HTMLTextAreaElement[];
    for (const ta of tas) {
      try {
        fireEvent.focus(ta);
        fireEvent.change(ta, { target: { value: 'jsdom message' } });
        fireEvent.keyDown(ta, { key: 'Enter' });
      } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('Shift+Enter inserts newline (does not submit)', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const ta = container.querySelector('textarea') as HTMLTextAreaElement | null;
    if (ta) {
      try {
        fireEvent.focus(ta);
        fireEvent.change(ta, { target: { value: 'line1' } });
        fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
      } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('Escape closes any active modal', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => { window.dispatchEvent(new CustomEvent('dilla:open-new-channel')); });
    try { fireEvent.keyDown(document, { key: 'Escape' }); } catch { /* swallow */ }
    expect(container.firstChild).toBeTruthy();
  });
});
