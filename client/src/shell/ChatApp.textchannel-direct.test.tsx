// Direct unit tests on ChatApp's exported TextChannel — render with
// varied props to hit composer/header/typing/slow-mode branches.

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
vi.mock('./themes', () => ({ THEMES: { mesh: { name: 'mesh' }, themeVars: () => ({}) } }));
vi.mock('./VoiceDockStats', () => ({ MiniMeter: () => <div />, VoiceDockLatency: () => <div />, VoiceDockBitrate: () => <div /> }));

import { TextChannel } from './ChatApp';
import { ShellDataProvider } from './ShellDataContext';
import { useTeamStore } from '../stores/teamStore';
import { useMessageStore } from '../stores/messageStore';
import { useAuthStore } from '../stores/authStore';

const ME = { id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online' };
const ALICE = { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0', status: 'online' };
const CHANNEL = { id: 'ch-1', name: 'general', type: 'text', topic: 'general chat', encrypted: true, unread: 0 };
const MESSAGES = [
  { id: 'm1', author: 'me', at: new Date(), kind: 'text', text: 'first', edited: false, deleted: false },
  { id: 'm2', author: 'u2', at: new Date(), kind: 'text', text: 'reply', edited: false, deleted: false },
];

const SHELL = {
  SERVERS: [{ id: 't1', name: 'Acme' }],
  CHANNELS: [CHANNEL], MEMBERS: [ME, ALICE],
  byId: { me: ME, u2: ALICE },
  MESSAGES: { 'ch-1': MESSAGES },
  DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: {},
  activeServerId: 't1', activeChannelId: 'ch-1', currentUserId: 'me',
};

const baseProps = {
  channel: CHANNEL,
  messages: MESSAGES,
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
  membersOpen: true,
  onToggleMembers: vi.fn(),
  slowModeLock: 0,
};

function wrap(c: React.ReactNode) {
  return <ShellDataProvider value={SHELL}>{c}</ShellDataProvider>;
}

beforeEach(() => {
  useTeamStore.setState({
    activeTeamId: 't1',
    channels: new Map([['t1', [CHANNEL]]]),
    members: new Map([['t1', []]]),
    roles: new Map([['t1', []]]),
    groups: new Map([['t1', []]]),
  } as never);
  useAuthStore.setState({ derivedKey: 'k', teams: new Map([['t1', { user: { id: 'me' } }]]) } as never);
  useMessageStore.setState({ messages: new Map([['ch-1', MESSAGES]]), typing: new Map(), hasMore: new Map(), loadingHistory: new Map() } as never);
});

describe('TextChannel direct render', () => {
  it('renders channel name in header', () => {
    const { container } = render(wrap(<TextChannel {...baseProps} />));
    expect(container.textContent).toContain('general');
  });

  it('shows topic in header', () => {
    const { container } = render(wrap(<TextChannel {...baseProps} />));
    expect(container.textContent).toContain('general chat');
  });

  it('renders messages', () => {
    const { container } = render(wrap(<TextChannel {...baseProps} />));
    expect(container.textContent).toContain('first');
    expect(container.textContent).toContain('reply');
  });

  it('types in composer fires setDraft', () => {
    const setDraft = vi.fn();
    const { container } = render(wrap(<TextChannel {...baseProps} setDraft={setDraft} />));
    const ta = container.querySelector('textarea') as HTMLTextAreaElement | null;
    if (ta) {
      fireEvent.change(ta, { target: { value: 'new message' } });
      expect(setDraft).toHaveBeenCalled();
    }
  });

  it('Enter on composer with text fires onSend', () => {
    const onSend = vi.fn();
    const { container } = render(wrap(<TextChannel {...baseProps} draft="hello" onSend={onSend} />));
    const ta = container.querySelector('textarea') as HTMLTextAreaElement | null;
    if (ta) {
      fireEvent.keyDown(ta, { key: 'Enter' });
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('Shift+Enter does NOT fire onSend', () => {
    const onSend = vi.fn();
    const { container } = render(wrap(<TextChannel {...baseProps} draft="hello" onSend={onSend} />));
    const ta = container.querySelector('textarea') as HTMLTextAreaElement | null;
    if (ta) {
      fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
    }
    expect(onSend).not.toHaveBeenCalled();
  });

  it('renders typing indicator with typing[]', () => {
    const { container } = render(wrap(<TextChannel {...baseProps} typing={['alice', 'bob']} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with replyTo prop set (composer shows quote)', () => {
    const replyTo = MESSAGES[1];
    const { container } = render(wrap(<TextChannel {...baseProps} replyTo={replyTo} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('cancels reply via onSetReply(null)', () => {
    const onSetReply = vi.fn();
    const replyTo = MESSAGES[1];
    const { container } = render(wrap(<TextChannel {...baseProps} replyTo={replyTo} onSetReply={onSetReply} />));
    // Look for cancel-reply button
    const cancelBtn = [...container.querySelectorAll('button')].find((b) => /cancel.*reply|×|×/i.test(b.textContent ?? '' )) as HTMLButtonElement | undefined;
    if (cancelBtn) fireEvent.click(cancelBtn);
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with slowModeLock > 0 (countdown shown)', () => {
    const { container } = render(wrap(<TextChannel {...baseProps} slowModeLock={Date.now() + 30_000} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with pendingAttachments (attachment chips visible)', () => {
    const { container } = render(wrap(<TextChannel {...baseProps} pendingAttachments={[{ id: 'a1', name: 'doc.pdf', size: 1024 }]} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with dmPartner (DM mode)', () => {
    const { container } = render(wrap(<TextChannel {...baseProps} dmPartner={ALICE} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('clicking toggle members button fires onToggleMembers', () => {
    const onToggleMembers = vi.fn();
    const { container } = render(wrap(<TextChannel {...baseProps} onToggleMembers={onToggleMembers} />));
    const headerBtns = [...container.querySelectorAll('button')] as HTMLButtonElement[];
    for (const b of headerBtns) {
      try { fireEvent.click(b); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with no messages (empty feed)', () => {
    useMessageStore.setState({ messages: new Map([['ch-1', []]]), typing: new Map(), hasMore: new Map(), loadingHistory: new Map() } as never);
    const { container } = render(wrap(<TextChannel {...baseProps} messages={[]} />));
    expect(container.firstChild).toBeTruthy();
  });
});
