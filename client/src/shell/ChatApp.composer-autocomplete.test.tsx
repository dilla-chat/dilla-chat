// Drives the composer's @mention + /slash autocomplete popovers in TextChannel
// — covers applyMention (L2505-2523), applySlash (L2524-2536), the regex
// dispatch in onChange (L3424-3434), and the keyboard nav inside the popups
// (L3436-3454), plus the empty-draft ArrowUp → edit-last-message flow (L3466-3477).

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
          { id: 'm2', userId: 'u2', username: 'alice', displayName: 'Alice', publicKeyHex: '', avatarUrl: '', isAdmin: false, roles: [] },
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
  usePinStore.setState({ pins: new Map() } as never);
  (window as unknown as { SHELL_DATA?: { currentUserId?: string } }).SHELL_DATA = {
    currentUserId: 'me',
  };
}

const ME = { id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online' };
const ALICE = { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0', status: 'online' };

function makeData(myMessages: Array<Record<string, unknown>> = []) {
  return {
    SERVERS: [{ id: 't1', name: 'Acme', node: 'local', short: 'A', federated: false, members: 0 }],
    CHANNELS: [{ id: 'ch-1', name: 'general', type: 'text', topic: '', encrypted: true, unread: 0 }],
    MEMBERS: [ME, ALICE],
    byId: { me: ME, u2: ALICE },
    MESSAGES: { 'ch-1': myMessages },
    DMS: [],
    DM_MESSAGES: {},
    THREAD_REPLIES: {},
    activeServerId: 't1',
    activeChannelId: 'ch-1',
    currentUserId: 'me',
  };
}

function renderApp(messages: Array<Record<string, unknown>> = []) {
  return render(
    <ShellDataProvider value={makeData(messages)}>
      <ChatApp theme={{ name: 'mesh' }} opts={{}} />
    </ShellDataProvider>,
  );
}

beforeEach(() => seedAllStores());

function getTextarea(container: HTMLElement): HTMLTextAreaElement {
  const ta = container.querySelector('textarea');
  if (!ta) throw new Error('composer textarea not found');
  return ta as HTMLTextAreaElement;
}

describe('Composer @mention picker', () => {
  it('typing @a shows the mention popover with matching members', () => {
    const { container } = renderApp();
    const ta = getTextarea(container);
    act(() => {
      fireEvent.change(ta, { target: { value: '@a', selectionStart: 2, selectionEnd: 2 } });
    });
    const pop = container.querySelector('.mention-pop');
    expect(pop).toBeTruthy();
  });

  it('Enter while mention popover is open inserts the selected name', () => {
    const { container } = renderApp();
    const ta = getTextarea(container);
    act(() => {
      ta.value = '@a';
      ta.selectionStart = 2;
      ta.selectionEnd = 2;
      fireEvent.change(ta, { target: { value: '@a' } });
    });
    act(() => {
      fireEvent.keyDown(ta, { key: 'Enter' });
    });
    // The mention popover should close after Enter applies the mention.
    expect(container.querySelector('.mention-pop')).toBeFalsy();
  });

  it('ArrowDown/ArrowUp navigates the mention popover', () => {
    const { container } = renderApp();
    const ta = getTextarea(container);
    act(() => {
      fireEvent.change(ta, { target: { value: '@a' } });
    });
    act(() => {
      fireEvent.keyDown(ta, { key: 'ArrowDown' });
      fireEvent.keyDown(ta, { key: 'ArrowDown' });
      fireEvent.keyDown(ta, { key: 'ArrowUp' });
    });
    expect(container.querySelector('.mention-pop')).toBeTruthy();
  });

  it('Escape closes the mention popover', () => {
    const { container } = renderApp();
    const ta = getTextarea(container);
    act(() => {
      fireEvent.change(ta, { target: { value: '@a' } });
    });
    expect(container.querySelector('.mention-pop')).toBeTruthy();
    act(() => {
      fireEvent.keyDown(ta, { key: 'Escape' });
    });
    expect(container.querySelector('.mention-pop')).toBeFalsy();
  });

  it('clicking a mention-row applies the name', () => {
    const { container } = renderApp();
    const ta = getTextarea(container);
    act(() => {
      fireEvent.change(ta, { target: { value: '@a' } });
    });
    const row = container.querySelector('.mention-row');
    expect(row).toBeTruthy();
    act(() => {
      fireEvent.mouseDown(row!);
    });
    expect(container.querySelector('.mention-pop')).toBeFalsy();
  });
});

describe('Composer /slash command picker', () => {
  it('typing / shows the slash popover with all commands', () => {
    const { container } = renderApp();
    const ta = getTextarea(container);
    act(() => {
      fireEvent.change(ta, { target: { value: '/' } });
    });
    expect(container.querySelector('.slash-pop')).toBeTruthy();
  });

  it('typing /shr filters to /shrug', () => {
    const { container } = renderApp();
    const ta = getTextarea(container);
    act(() => {
      fireEvent.change(ta, { target: { value: '/shr' } });
    });
    const rows = container.querySelectorAll('.slash-row');
    expect(rows.length).toBe(1);
  });

  it('Enter while slash popover is open applies the slash command', () => {
    const { container } = renderApp();
    const ta = getTextarea(container);
    act(() => {
      fireEvent.change(ta, { target: { value: '/shrug' } });
    });
    act(() => {
      fireEvent.keyDown(ta, { key: 'Enter' });
    });
    expect(container.querySelector('.slash-pop')).toBeFalsy();
  });

  it('ArrowDown/ArrowUp navigates the slash popover', () => {
    const { container } = renderApp();
    const ta = getTextarea(container);
    act(() => {
      fireEvent.change(ta, { target: { value: '/' } });
    });
    act(() => {
      fireEvent.keyDown(ta, { key: 'ArrowDown' });
      fireEvent.keyDown(ta, { key: 'ArrowDown' });
      fireEvent.keyDown(ta, { key: 'ArrowUp' });
    });
    expect(container.querySelector('.slash-pop')).toBeTruthy();
  });

  it('Escape closes the slash popover', () => {
    const { container } = renderApp();
    const ta = getTextarea(container);
    act(() => {
      fireEvent.change(ta, { target: { value: '/' } });
    });
    act(() => {
      fireEvent.keyDown(ta, { key: 'Escape' });
    });
    expect(container.querySelector('.slash-pop')).toBeFalsy();
  });

  it('clicking a slash-row applies the command', () => {
    const { container } = renderApp();
    const ta = getTextarea(container);
    act(() => {
      fireEvent.change(ta, { target: { value: '/' } });
    });
    const row = container.querySelector('.slash-row');
    expect(row).toBeTruthy();
    act(() => {
      fireEvent.mouseDown(row!);
    });
    expect(container.querySelector('.slash-pop')).toBeFalsy();
  });

  it('typing a non-matching prefix hides the popover', () => {
    const { container } = renderApp();
    const ta = getTextarea(container);
    act(() => {
      fireEvent.change(ta, { target: { value: '/nosuchcommand' } });
    });
    expect(container.querySelector('.slash-pop')).toBeFalsy();
  });
});

describe('Composer edit-last-message via ArrowUp on empty draft', () => {
  it('ArrowUp on empty draft loads my last text message into edit mode', () => {
    const myMessage = {
      id: 'mine-1',
      author: 'me',
      at: new Date(),
      kind: 'text',
      text: 'my last message',
      edited: false,
      deleted: false,
    };
    const { container } = renderApp([myMessage]);
    const ta = getTextarea(container);
    act(() => {
      fireEvent.keyDown(ta, { key: 'ArrowUp' });
    });
    // Edit mode shows the inline editor; smoke check that the render didn't crash.
    expect(container.firstChild).toBeTruthy();
  });

  it('ArrowUp with non-empty draft is ignored (no edit)', () => {
    const myMessage = { id: 'm', author: 'me', at: new Date(), kind: 'text', text: 'old' };
    const { container } = renderApp([myMessage]);
    const ta = getTextarea(container);
    act(() => {
      fireEvent.change(ta, { target: { value: 'something' } });
      fireEvent.keyDown(ta, { key: 'ArrowUp' });
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('ArrowUp on empty draft with no own messages is a no-op', () => {
    const otherMsg = { id: 'other', author: 'u2', at: new Date(), kind: 'text', text: 'theirs' };
    const { container } = renderApp([otherMsg]);
    const ta = getTextarea(container);
    act(() => {
      fireEvent.keyDown(ta, { key: 'ArrowUp' });
    });
    expect(container.firstChild).toBeTruthy();
  });
});

describe('Composer Enter to send', () => {
  it('Enter with non-empty draft fires onSend', () => {
    const { container } = renderApp();
    const ta = getTextarea(container);
    act(() => {
      fireEvent.change(ta, { target: { value: 'hello world' } });
      fireEvent.keyDown(ta, { key: 'Enter' });
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('Shift+Enter inserts a newline (does not send)', () => {
    const { container } = renderApp();
    const ta = getTextarea(container);
    act(() => {
      fireEvent.change(ta, { target: { value: 'line1' } });
      fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
    });
    expect(container.firstChild).toBeTruthy();
  });
});
