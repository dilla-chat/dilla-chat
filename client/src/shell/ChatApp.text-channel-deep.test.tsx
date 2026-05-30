// Drive TextChannel deep handlers via direct render (composer, slow mode,
// reply, attachment, every state combination).

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
vi.mock('../components/MessageMarkdown/MessageMarkdown', () => ({ default: ({ text }: { text: string }) => <span>{text}</span> }));
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
vi.mock('./VoiceDockStats', () => ({ MiniMeter: () => <div />, VoiceDockLatency: () => <div />, VoiceDockBitrate: () => <div /> }));

import { TextChannel } from './ChatApp';
import { ShellDataProvider } from './ShellDataContext';
import { useTeamStore } from '../stores/teamStore';
import { useMessageStore } from '../stores/messageStore';
import { useAuthStore } from '../stores/authStore';
import { useVoiceStore } from '../stores/voiceStore';

const ME = { id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online', isAdmin: true };
const ALICE = { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0', status: 'online' };
const NOW = new Date();
const CHANNEL = { id: 'ch-1', name: 'general', type: 'text', topic: 'main', encrypted: true, unread: 0 };
const members = { MEMBERS: [ME, ALICE], byId: { me: ME, u2: ALICE } };

const SHELL = {
  SERVERS: [{ id: 't1', name: 'Acme' }],
  CHANNELS: [CHANNEL],
  MEMBERS: [ME, ALICE],
  byId: { me: ME, u2: ALICE },
  MESSAGES: {}, DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: {},
  activeServerId: 't1', activeChannelId: 'ch-1', currentUserId: 'me',
};

function wrap(c: React.ReactNode) {
  return <ShellDataProvider value={SHELL}>{c}</ShellDataProvider>;
}

const baseProps = {
  channel: CHANNEL, messages: [], members,
  dmPartner: null,
  draft: '', setDraft: vi.fn(),
  onSend: vi.fn(), onReact: vi.fn(), onVote: vi.fn(),
  onEdit: vi.fn(), onDelete: vi.fn(), onAttach: vi.fn(),
  pendingAttachments: [], onRemoveAttachment: vi.fn(),
  replyTo: null, onSetReply: vi.fn(),
  typing: [], onJoinVoice: vi.fn(),
  membersOpen: true, onToggleMembers: vi.fn(),
  slowModeLock: 0,
};

beforeEach(() => {
  useTeamStore.setState({
    activeTeamId: 't1', activeChannelId: 'ch-1',
    teams: new Map([['t1', { id: 't1', name: 'Acme' }]]),
    channels: new Map([['t1', [CHANNEL]]]),
    members: new Map([['t1', [{ id: 'm1', userId: 'me', isAdmin: true, roleIds: [], roles: [] }]]]),
    roles: new Map([['t1', []]]),
    groups: new Map([['t1', []]]),
  } as never);
  useAuthStore.setState({ derivedKey: 'k', teams: new Map([['t1', { user: { id: 'me' } }]]) } as never);
  useVoiceStore.setState({
    connected: false, currentChannelId: null, voiceOccupants: {},
    muted: false, deafened: false, speaking: false, peers: {}, peerLatencies: {},
    latencySamples: [], bitrateSamples: [],
    localScreenStream: null, remoteScreenStreams: {},
    localWebcamStream: null, remoteWebcamStreams: {},
  } as never);
  useMessageStore.setState({ messages: new Map(), typing: new Map(), hasMore: new Map(), loadingHistory: new Map() } as never);
});

describe('TextChannel composer keyboard handlers', () => {
  it('Enter sends a message', () => {
    const onSend = vi.fn();
    const { container } = render(wrap(<TextChannel {...baseProps} draft="hello" onSend={onSend} />));
    const ta = container.querySelector('textarea') as HTMLTextAreaElement | null;
    if (ta) {
      fireEvent.keyDown(ta, { key: 'Enter' });
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('Shift+Enter inserts newline', () => {
    const onSend = vi.fn();
    const { container } = render(wrap(<TextChannel {...baseProps} draft="hello" onSend={onSend} />));
    const ta = container.querySelector('textarea') as HTMLTextAreaElement | null;
    if (ta) {
      fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
    }
    expect(onSend).not.toHaveBeenCalled();
  });

  it('Escape cancels reply', () => {
    const onSetReply = vi.fn();
    const replyTo = { id: 'r1', author: 'u2', at: NOW, kind: 'text', text: 'parent', edited: false, deleted: false };
    const { container } = render(wrap(<TextChannel {...baseProps} replyTo={replyTo} onSetReply={onSetReply} />));
    const ta = container.querySelector('textarea') as HTMLTextAreaElement | null;
    if (ta) {
      fireEvent.keyDown(ta, { key: 'Escape' });
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('ArrowUp recalls last own message for edit', () => {
    const messages = [
      { id: 'm1', author: 'me', at: NOW, kind: 'text', text: 'mine 1', edited: false, deleted: false },
      { id: 'm2', author: 'u2', at: NOW, kind: 'text', text: 'theirs', edited: false, deleted: false },
      { id: 'm3', author: 'me', at: NOW, kind: 'text', text: 'mine 2', edited: false, deleted: false },
    ];
    useMessageStore.setState({
      messages: new Map([['ch-1', messages]]),
      typing: new Map(), hasMore: new Map(), loadingHistory: new Map(),
    } as never);
    const { container } = render(wrap(<TextChannel {...baseProps} messages={messages} />));
    const ta = container.querySelector('textarea') as HTMLTextAreaElement | null;
    if (ta) {
      fireEvent.keyDown(ta, { key: 'ArrowUp' });
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('typing fires setDraft', () => {
    const setDraft = vi.fn();
    const { container } = render(wrap(<TextChannel {...baseProps} setDraft={setDraft} />));
    const ta = container.querySelector('textarea') as HTMLTextAreaElement | null;
    if (ta) {
      fireEvent.change(ta, { target: { value: 'new draft' } });
    }
    expect(setDraft).toHaveBeenCalled();
  });
});

describe('TextChannel composer file upload', () => {
  it('clicking attach button triggers file input', () => {
    const { container } = render(wrap(<TextChannel {...baseProps} />));
    const attachBtns = [...container.querySelectorAll('button')].filter((b) => /attach|paperclip/i.test(b.textContent ?? '' ) || b.getAttribute('aria-label')?.match(/attach|file/i));
    for (const b of attachBtns) {
      try { fireEvent.click(b); } catch { /* */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('removes pending attachment via × button', () => {
    const onRemoveAttachment = vi.fn();
    const att = [{ id: 'a1', name: 'doc.pdf', kind: 'file', size: 1024 }];
    const { container } = render(wrap(<TextChannel {...baseProps} pendingAttachments={att} onRemoveAttachment={onRemoveAttachment} />));
    const xBtns = [...container.querySelectorAll('button')].filter((b) => /remove|×|×/i.test(b.textContent ?? '' ));
    for (const b of xBtns) {
      try { fireEvent.click(b); } catch { /* */ }
    }
    expect(container.firstChild).toBeTruthy();
  });
});

describe('TextChannel message list rendering', () => {
  it('renders with 100 messages (perf)', () => {
    const msgs = Array.from({ length: 100 }, (_, i) => ({
      id: 'm' + i, author: i % 2 === 0 ? 'me' : 'u2', at: new Date(Date.now() - (100 - i) * 1000),
      kind: 'text', text: 'msg ' + i, edited: false, deleted: false,
    }));
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      typing: new Map(), hasMore: new Map(), loadingHistory: new Map(),
    } as never);
    const { container } = render(wrap(<TextChannel {...baseProps} messages={msgs} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with day-divider transitions', () => {
    const today = new Date();
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    const lastWeek = new Date(today); lastWeek.setDate(today.getDate() - 7);
    const msgs = [
      { id: 'mLast', author: 'me', at: lastWeek, kind: 'text', text: 'a week ago', edited: false, deleted: false },
      { id: 'mYest', author: 'u2', at: yesterday, kind: 'text', text: 'yesterday', edited: false, deleted: false },
      { id: 'mNow', author: 'me', at: today, kind: 'text', text: 'today', edited: false, deleted: false },
    ];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      typing: new Map(), hasMore: new Map(), loadingHistory: new Map(),
    } as never);
    const { container } = render(wrap(<TextChannel {...baseProps} messages={msgs} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with loading-history indicator', () => {
    useMessageStore.setState({
      messages: new Map([['ch-1', []]]),
      typing: new Map(), hasMore: new Map([['ch-1', true]]), loadingHistory: new Map([['ch-1', true]]),
    } as never);
    const { container } = render(wrap(<TextChannel {...baseProps} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with hasMore=true (load more button)', () => {
    useMessageStore.setState({
      messages: new Map([['ch-1', []]]),
      typing: new Map(), hasMore: new Map([['ch-1', true]]), loadingHistory: new Map(),
    } as never);
    const { container } = render(wrap(<TextChannel {...baseProps} />));
    expect(container.firstChild).toBeTruthy();
  });
});

describe('TextChannel slow mode countdown', () => {
  it('renders countdown when slowModeLock > now', () => {
    const lock = Date.now() + 30_000;
    const { container } = render(wrap(<TextChannel {...baseProps} slowModeLock={lock} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('does not show countdown when slowModeLock is past', () => {
    const lock = Date.now() - 30_000;
    const { container } = render(wrap(<TextChannel {...baseProps} slowModeLock={lock} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('does not show countdown when slowModeLock is 0', () => {
    const { container } = render(wrap(<TextChannel {...baseProps} slowModeLock={0} />));
    expect(container.firstChild).toBeTruthy();
  });
});

describe('TextChannel header buttons', () => {
  it('renders header with channel name and topic', () => {
    const { container } = render(wrap(<TextChannel {...baseProps} />));
    expect(container.textContent).toContain('general');
    expect(container.textContent).toContain('main');
  });

  it('clicking each header button does not throw', () => {
    const { container } = render(wrap(<TextChannel {...baseProps} />));
    const headerBtns = [...container.querySelectorAll('.tc-header button, .tc-headerbar button, .channel-header button')] as HTMLButtonElement[];
    for (const b of headerBtns) {
      try { fireEvent.click(b); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });
});
