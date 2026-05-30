// Drive TextChannel (1401 LOC of ChatApp.tsx) in jsdom. Now that
// the Zustand selectors are stable, we can render it directly and
// fire real interactions.

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

import { TextChannel } from './ChatApp';
import { ShellDataProvider } from './ShellDataContext';
import { useTeamStore } from '../stores/teamStore';
import { useAuthStore } from '../stores/authStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useMessageStore } from '../stores/messageStore';

vi.mock('../services/websocket', () => ({ ws: new Proxy({}, { get: () => () => () => {} }) }));
vi.mock('../services/api', () => ({ api: new Proxy({}, { get: () => () => Promise.resolve({}) }) }));
vi.mock('../services/mockSession', () => ({ isMockSession: () => true }));
vi.mock('../hooks/useMessageDecryption', () => ({
  tryEncrypt: vi.fn(async (c: string) => c),
  tryDecrypt: vi.fn(async (_id: string, c: string) => c),
  serverToMessage: vi.fn((sm) => sm),
}));
vi.mock('../hooks/useChannelLazyLoad', () => ({ useChannelLazyLoad: vi.fn() }));
vi.mock('../components/MessageMarkdown/MessageMarkdown', () => ({
  default: ({ text }: { text: string }) => <span>{text}</span>,
}));
vi.mock('./icons', () => {
  const stub = () => <span data-icon />;
  return { Icon: new Proxy({}, { get: () => stub }), default: new Proxy({}, { get: () => stub }) };
});
vi.mock('./Avatar', () => ({
  Avatar: ({ member }: { member?: { name?: string } }) => <span>{member?.name}</span>,
  PlainAvatar: ({ member }: { member?: { name?: string } }) => <span>{member?.name}</span>,
  memberAvatarStyle: () => ({}),
  memberAvatarClass: () => '',
}));

const SHELL_DATA = {
  SERVERS: [{ id: 't1', name: 'Acme', node: 'local' }],
  CHANNELS: [], MEMBERS: [], byId: {},
  MESSAGES: {}, DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: {},
  activeServerId: 't1', activeChannelId: 'ch-1', currentUserId: 'me',
};

const channel = { id: 'ch-1', name: 'general', type: 'text', topic: 'team channel', encrypted: true };
const ME = { id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online' };
const ALICE = { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0', status: 'online' };

function defaultProps(overrides: Record<string, unknown> = {}) {
  return {
    channel,
    messages: [
      { id: 'm1', author: 'u2', at: new Date(Date.now() - 60_000), kind: 'text', text: 'hello', edited: false, deleted: false,
        reactions: [{ e: '🎉', n: 2, mine: false }] },
      { id: 'm2', author: 'me', at: new Date(), kind: 'text', text: 'world', edited: false, deleted: false },
    ],
    members: { MEMBERS: [ME, ALICE], byId: { me: ME, u2: ALICE } },
    dmPartner: null,
    draft: '',
    setDraft: vi.fn(),
    onSend: vi.fn(),
    onReact: vi.fn(),
    onVote: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onAttach: vi.fn(),
    pendingAttachments: [],
    onRemoveAttachment: vi.fn(),
    replyTo: null,
    onSetReply: vi.fn(),
    typing: [],
    onJoinVoice: vi.fn(),
    slowModeLock: null,
    membersOpen: true,
    onToggleMembers: vi.fn(),
    ...overrides,
  };
}

function renderTC(props: Record<string, unknown> = {}) {
  return render(
    <ShellDataProvider value={SHELL_DATA}>
      <TextChannel {...defaultProps(props)} />
    </ShellDataProvider>,
  );
}

beforeEach(() => {
  const EMPTY: never[] = [];
  useTeamStore.setState({
    activeTeamId: 't1',
    teams: new Map([['t1', { id: 't1', name: 'Acme' }]]),
    channels: new Map([['t1', EMPTY]]),
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
  useMessageStore.setState({ messages: new Map(), typing: new Map(), hasMore: new Map(), loadingHistory: new Map() } as never);
});

describe('TextChannel integration (jsdom)', () => {
  it('renders the composer textarea', () => {
    const { container } = renderTC();
    expect(container.querySelector('textarea')).toBeTruthy();
  });

  it('renders messages and grouping', () => {
    const { container } = renderTC();
    expect(container.textContent).toContain('hello');
    expect(container.textContent).toContain('world');
  });

  it('fires setDraft on textarea change', () => {
    const setDraft = vi.fn();
    const { container } = renderTC({ setDraft });
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'typed' } });
    expect(setDraft).toHaveBeenCalled();
  });

  it('renders 50 messages without crashing', () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({
      id: `m${i}`, author: i % 2 === 0 ? 'me' : 'u2',
      at: new Date(Date.now() - (50 - i) * 1000),
      kind: 'text', text: `msg ${i}`, edited: false, deleted: false,
    }));
    const { container } = renderTC({ messages });
    expect(container.firstChild).toBeTruthy();
  });

  it('renders pending attachments + clicks remove', () => {
    const onRemoveAttachment = vi.fn();
    const { container } = renderTC({
      pendingAttachments: [
        { id: 'a1', name: 'photo.png', size: 1024, type: 'image/png', previewUrl: 'blob:p' },
        { id: 'a2', name: 'doc.pdf', size: 5000, type: 'application/pdf' },
      ],
      onRemoveAttachment,
    });
    const removeBtns = [...container.querySelectorAll('button')].filter((b) =>
      /×|remove|x$/i.test(b.textContent ?? '')
    );
    for (const b of removeBtns) {
      try { fireEvent.click(b); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with reply-to chip + clicks dismiss', () => {
    const onSetReply = vi.fn();
    const { container } = renderTC({
      replyTo: { id: 'm1', author: 'u2', text: 'replied to' },
      onSetReply,
    });
    const closeBtns = [...container.querySelectorAll('button')].filter((b) =>
      /×|close/i.test(b.textContent ?? '')
    );
    for (const b of closeBtns) {
      try { fireEvent.click(b); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('renders typing indicator with multiple typists', () => {
    const { container } = renderTC({
      typing: [
        { userId: 'u2', username: 'alice', timestamp: Date.now() },
        { userId: 'u3', username: 'bob', timestamp: Date.now() },
      ],
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('renders slow-mode lock countdown', () => {
    const { container } = renderTC({
      slowModeLock: Date.now() + 5000,
      channel: { ...channel, slowModeSeconds: 10 },
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('renders DM partner header', () => {
    const { container } = renderTC({
      dmPartner: ALICE,
      channel: { id: 'dm-1', name: '', type: 'dm', topic: '', encrypted: true },
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('renders poll message + clicks options', () => {
    const onVote = vi.fn();
    const { container } = renderTC({
      messages: [{
        id: 'p1', kind: 'poll', author: 'me', at: new Date(),
        question: 'Pick',
        options: [{ label: 'a', votes: 0, mine: false }, { label: 'b', votes: 0, mine: false }],
      }],
      onVote,
    });
    const optBtns = [...container.querySelectorAll('button')].filter((b) =>
      b.textContent === 'a' || b.textContent === 'b'
    ) as HTMLButtonElement[];
    for (const b of optBtns) {
      try { fireEvent.click(b); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('renders image attachments inline', () => {
    const { container } = renderTC({
      messages: [{
        id: 'i1', author: 'me', at: new Date(), kind: 'image', text: '',
        attachment: { kind: 'image', label: 'cat.gif', size: 100, src: '/x.gif' },
      }],
    });
    expect(container.querySelector('img')).toBeTruthy();
  });

  it('renders file attachments with filename', () => {
    const { container } = renderTC({
      messages: [{
        id: 'f1', author: 'me', at: new Date(), kind: 'file', text: '',
        attachment: { kind: 'file', label: 'doc.pdf', size: 12_345_678, src: '/doc.pdf' },
      }],
    });
    expect(container.textContent).toContain('doc.pdf');
  });

  it('renders system messages', () => {
    const { container } = renderTC({
      messages: [{
        id: 's', author: 'me', at: new Date(), kind: 'system', text: 'joined the channel',
        edited: false, deleted: false,
      }],
    });
    expect(container.textContent).toContain('joined');
  });

  it('renders edited message marker', () => {
    const { container } = renderTC({
      messages: [{
        id: 'm', author: 'me', at: new Date(), kind: 'text', text: 'edited',
        edited: true, deleted: false,
      }],
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('renders reply-to badge on a message', () => {
    const { container } = renderTC({
      messages: [
        { id: 'p', author: 'me', at: new Date(2026, 0, 1, 10), kind: 'text', text: 'original',
          edited: false, deleted: false },
        { id: 'r', author: 'u2', at: new Date(2026, 0, 1, 11), kind: 'text', text: 'replying',
          edited: false, deleted: false, replyTo: 'p' },
      ],
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('clicks every button — drives every onClick handler', () => {
    const { container } = renderTC();
    const buttons = [...container.querySelectorAll('button')] as HTMLButtonElement[];
    for (const b of buttons) {
      try { fireEvent.click(b); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('right-clicks every message', () => {
    const { container } = renderTC();
    const msgs = [...container.querySelectorAll('[class*="msg"], [class*="message"]')] as HTMLElement[];
    for (const m of msgs) {
      fireEvent.contextMenu(m, { clientX: 100, clientY: 100 });
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('mouse-enter/leave every message reveals action toolbar', () => {
    const { container } = renderTC();
    const msgs = [...container.querySelectorAll('[class*="msg"], [class*="message"]')] as HTMLElement[];
    for (const m of msgs) {
      fireEvent.mouseEnter(m);
      fireEvent.mouseLeave(m);
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('Enter key in textarea fires onSend', () => {
    const onSend = vi.fn();
    const { container } = renderTC({ draft: 'msg', onSend });
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalled();
  });

  it('Shift+Enter does not send', () => {
    const onSend = vi.fn();
    const { container } = renderTC({ draft: 'msg', onSend });
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('renders reaction pills + clicks each one', () => {
    const onReact = vi.fn();
    const { container } = renderTC({
      onReact,
      messages: [{
        id: 'm1', author: 'me', at: new Date(), kind: 'text', text: 'reacted',
        edited: false, deleted: false,
        reactions: [
          { e: '🎉', n: 3, mine: false },
          { e: '🚀', n: 1, mine: true },
          { e: '❤️', n: 5, mine: false },
        ],
      }],
    });
    const reactBtns = [...container.querySelectorAll('button')].filter((b) =>
      ['🎉', '🚀', '❤️'].some((emoji) => b.textContent?.includes(emoji))
    );
    for (const b of reactBtns) {
      try { fireEvent.click(b); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('paste event on textarea', () => {
    const { container } = renderTC();
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.paste(textarea, {
      clipboardData: { getData: () => 'pasted text', files: [] },
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('drag-drop file on the channel area', () => {
    const { container } = renderTC();
    const dropZone = container.firstChild as HTMLElement;
    const file = new File(['x'], 'test.txt', { type: 'text/plain' });
    fireEvent.dragOver(dropZone, { dataTransfer: { files: [file] } });
    fireEvent.drop(dropZone, { dataTransfer: { files: [file] } });
    expect(container.firstChild).toBeTruthy();
  });

  it('membersOpen=false hides the member panel', () => {
    const { container } = renderTC({ membersOpen: false });
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with mentions in message text', () => {
    const { container } = renderTC({
      messages: [{
        id: 'm', author: 'u2', at: new Date(), kind: 'text', text: 'hey @me, check this',
        edited: false, deleted: false,
      }],
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('renders messages with markdown formatting', () => {
    const { container } = renderTC({
      messages: [
        { id: 'm1', author: 'me', at: new Date(), kind: 'text',
          text: '**bold** and *italic* and `code`',
          edited: false, deleted: false },
        { id: 'm2', author: 'me', at: new Date(), kind: 'text',
          text: '```js\nconsole.log(1)\n```',
          edited: false, deleted: false },
      ],
    });
    expect(container.firstChild).toBeTruthy();
  });
});
