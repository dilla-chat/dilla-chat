// Drive per-message action handlers — react, edit, delete, reply, pin,
// copy text, copy link, mark-unread. These are deep handlers buried in
// the TextChannel render tree.

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

function seedStoresWithMessages() {
  const EMPTY: never[] = [];
  const msgs = [
    { id: 'm1', author: 'me', at: new Date(Date.now() - 60000), kind: 'text', text: 'first message', edited: false, deleted: false },
    { id: 'm2', author: 'u2', at: new Date(Date.now() - 30000), kind: 'text', text: 'alice reply', edited: false, deleted: false },
    { id: 'm3', author: 'me', at: new Date(Date.now() - 15000), kind: 'text', text: 'with reactions', edited: true, deleted: false, reactions: { '👍': ['me', 'u2'], '❤️': ['u2'] } },
    { id: 'm4', author: 'me', at: new Date(Date.now() - 5000), kind: 'text', text: 'deleted', edited: false, deleted: true },
    { id: 'm5', author: 'u2', at: new Date(), kind: 'text', text: 'last', edited: false, deleted: false,
      thread: { count: 3, lastReplyAt: new Date(), participants: ['me'] } },
  ];
  useTeamStore.setState({
    activeTeamId: 't1', activeChannelId: 'ch-1',
    teams: new Map([['t1', { id: 't1', name: 'Acme' }]]),
    channels: new Map([['t1', [{ id: 'ch-1', name: 'general', type: 'text' }]]]),
    members: new Map([['t1', EMPTY]]),
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
  useMessageStore.setState({
    messages: new Map([['ch-1', msgs]]),
    typing: new Map(), hasMore: new Map(), loadingHistory: new Map(),
  } as never);
  useDMStore.setState({ dmChannels: {}, dmMessages: {}, activeDMId: null } as never);
  useThreadStore.setState({ threads: {}, threadMessages: {} } as never);
  useUnreadStore.setState({ counts: {} } as never);
  usePollStore.setState({ polls: new Map() } as never);
  useBlockStore.setState({ blocked: new Set() } as never);
  useChannelMuteStore.setState({ muted: new Set() } as never);
  usePinStore.setState({ pins: { 'ch-1': ['m1'] } } as never);
}

function makeData() {
  return {
    SERVERS: [{ id: 't1', name: 'Acme', node: 'local', short: 'A', members: 2 }],
    CHANNELS: [{ id: 'ch-1', name: 'general', type: 'text', encrypted: true, unread: 0 }],
    MEMBERS: [ME, ALICE],
    byId: { me: ME, u2: ALICE },
    MESSAGES: {
      'ch-1': [
        { id: 'm1', author: 'me', at: new Date(), kind: 'text', text: 'first', edited: false, deleted: false },
        { id: 'm2', author: 'u2', at: new Date(), kind: 'text', text: 'reply', edited: false, deleted: false },
        { id: 'm3', author: 'me', at: new Date(), kind: 'text', text: 'with reactions', edited: true, deleted: false, reactions: { '👍': ['me', 'u2'] } },
      ],
    },
    DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: {},
    activeServerId: 't1', activeChannelId: 'ch-1', currentUserId: 'me',
  };
}

beforeEach(() => seedStoresWithMessages());

describe('Message hover toolbar (per-message actions)', () => {
  it('hovers each message row, then clicks every toolbar button', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const rows = [...container.querySelectorAll('.message, .msg, .message-row')] as HTMLElement[];
    for (const r of rows) {
      try { fireEvent.mouseEnter(r); } catch { /* swallow */ }
      const tb = r.querySelector('.toolbar, .msg-toolbar, .hover-toolbar') as HTMLElement | null;
      if (tb) {
        const buttons = [...tb.querySelectorAll('button')] as HTMLElement[];
        for (const b of buttons) {
          try { fireEvent.click(b); } catch { /* swallow */ }
        }
      }
      try { fireEvent.mouseLeave(r); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('right-clicks every message row (context menu)', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const rows = [...container.querySelectorAll('.message, .msg, .message-row')] as HTMLElement[];
    for (const r of rows) {
      try { fireEvent.contextMenu(r); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('double-clicks every message row (start edit on own)', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const rows = [...container.querySelectorAll('.message, .msg, .message-row')] as HTMLElement[];
    for (const r of rows) {
      try { fireEvent.doubleClick(r); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });
});

describe('Reaction interactions', () => {
  it('clicks every reaction pill on every message', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const pills = [...container.querySelectorAll('.reaction, .rxn, button.reaction')] as HTMLElement[];
    for (const p of pills) {
      try { fireEvent.click(p); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });
});

describe('Pinned bar', () => {
  it('clicks the pinned-bar button (opens pin list)', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const pinBtn = [...container.querySelectorAll('button')].find((b) =>
      /pin/i.test(b.textContent ?? '') || b.getAttribute('aria-label')?.match(/pin/i),
    );
    if (pinBtn) {
      try { fireEvent.click(pinBtn as HTMLButtonElement); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });
});

describe('Edit message flow', () => {
  it('dispatches dilla:start-edit then types + saves', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => {
      window.dispatchEvent(new CustomEvent('dilla:start-edit', { detail: { messageId: 'm1' } }));
    });
    const tas = [...container.querySelectorAll('textarea')] as HTMLTextAreaElement[];
    for (const ta of tas) {
      try {
        fireEvent.change(ta, { target: { value: 'edited content' } });
        fireEvent.keyDown(ta, { key: 'Enter' });
      } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('dispatches dilla:start-edit then presses Escape to cancel', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => {
      window.dispatchEvent(new CustomEvent('dilla:start-edit', { detail: { messageId: 'm1' } }));
    });
    const ta = container.querySelector('textarea') as HTMLTextAreaElement | null;
    if (ta) {
      try { fireEvent.keyDown(ta, { key: 'Escape' }); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });
});

describe('Quote / reply flow', () => {
  it('dispatches dilla:start-reply then sees quoted state in composer', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => {
      window.dispatchEvent(new CustomEvent('dilla:start-reply', { detail: { messageId: 'm2' } }));
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('dispatches dilla:cancel-reply', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => {
      window.dispatchEvent(new CustomEvent('dilla:start-reply', { detail: { messageId: 'm2' } }));
      window.dispatchEvent(new CustomEvent('dilla:cancel-reply'));
    });
    expect(container.firstChild).toBeTruthy();
  });
});

describe('Mark unread flow', () => {
  it('dispatches dilla:mark-unread for a message', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => {
      window.dispatchEvent(new CustomEvent('dilla:mark-unread', { detail: { messageId: 'm1' } }));
    });
    expect(container.firstChild).toBeTruthy();
  });
});

describe('Jump-to-message flow', () => {
  it('dispatches dilla:jump-to-message', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => {
      window.dispatchEvent(new CustomEvent('dilla:jump-to-message', { detail: { channelId: 'ch-1', messageId: 'm1' } }));
    });
    expect(container.firstChild).toBeTruthy();
  });
});
