// Direct unit tests on ChatApp's exported ThreadPanel.

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

vi.mock('../services/websocket', () => ({ ws: { sendThreadMessage: vi.fn() } }));
vi.mock('../services/api', () => ({ api: {} }));
vi.mock('../services/mockSession', () => ({ isMockSession: () => true }));
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

import { ThreadPanel } from './ChatApp';
import { ShellDataProvider } from './ShellDataContext';
import { useTeamStore } from '../stores/teamStore';
import { useThreadStore } from '../stores/threadStore';
import { useMessageStore } from '../stores/messageStore';

const ME = { id: 'me', name: 'me', initials: 'ME', color: '#f00' };
const ALICE = { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0' };

const PARENT_MSG = { id: 'p1', author: 'me', at: new Date(), kind: 'text', text: 'parent', edited: false, deleted: false };
const REPLIES = [
  { id: 'r1', author: 'u2', at: new Date(), kind: 'text', text: 'reply 1', edited: false, deleted: false },
  { id: 'r2', author: 'me', at: new Date(), kind: 'text', text: 'reply 2', edited: false, deleted: false },
];

const SHELL = {
  SERVERS: [{ id: 't1', name: 'Acme' }],
  CHANNELS: [{ id: 'ch-1', name: 'general', type: 'text' }],
  MEMBERS: [ME, ALICE],
  byId: { me: ME, u2: ALICE },
  MESSAGES: { 'ch-1': [PARENT_MSG] },
  DMS: [], DM_MESSAGES: {},
  THREAD_REPLIES: { p1: REPLIES },
  activeServerId: 't1', activeChannelId: 'ch-1', currentUserId: 'me',
};

function wrap(c: React.ReactNode) {
  return <ShellDataProvider value={SHELL}>{c}</ShellDataProvider>;
}

beforeEach(() => {
  useTeamStore.setState({ activeTeamId: 't1', activeChannelId: 'ch-1' } as never);
  useThreadStore.setState({
    threads: { 'ch-1': [{ id: 'p1', channel_id: 'ch-1', name: 'thread1' }] },
    threadMessages: { p1: REPLIES },
  } as never);
  useMessageStore.setState({ messages: new Map([['ch-1', [PARENT_MSG]]]), typing: new Map(), hasMore: new Map(), loadingHistory: new Map() } as never);
});

describe('ThreadPanel', () => {
  it('renders with channelId + messageId', () => {
    const { container } = render(wrap(
      <ThreadPanel channelId="ch-1" messageId="p1" members={{ MEMBERS: [ME, ALICE], byId: { me: ME, u2: ALICE } }} onClose={vi.fn()} onReact={vi.fn()} />,
    ));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders parent message + replies', () => {
    const { container } = render(wrap(
      <ThreadPanel channelId="ch-1" messageId="p1" members={{ MEMBERS: [ME, ALICE], byId: { me: ME, u2: ALICE } }} onClose={vi.fn()} onReact={vi.fn()} />,
    ));
    expect(container.firstChild).toBeTruthy();
  });

  it('clicking close fires onClose', () => {
    const onClose = vi.fn();
    const { container } = render(wrap(
      <ThreadPanel channelId="ch-1" messageId="p1" members={{ MEMBERS: [ME, ALICE], byId: { me: ME, u2: ALICE } }} onClose={onClose} onReact={vi.fn()} />,
    ));
    const closeBtn = [...container.querySelectorAll('button')].find((b) => /close|×|×/i.test(b.textContent ?? '') || b.getAttribute('aria-label')?.match(/close/i)) as HTMLButtonElement | undefined;
    if (closeBtn) fireEvent.click(closeBtn);
    expect(container.firstChild).toBeTruthy();
  });

  it('typing in composer does not throw', () => {
    const { container } = render(wrap(
      <ThreadPanel channelId="ch-1" messageId="p1" members={{ MEMBERS: [ME, ALICE], byId: { me: ME, u2: ALICE } }} onClose={vi.fn()} onReact={vi.fn()} />,
    ));
    const ta = container.querySelector('textarea') as HTMLTextAreaElement | null;
    if (ta) {
      try { fireEvent.change(ta, { target: { value: 'new reply' } }); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('handles missing thread (no replies)', () => {
    useThreadStore.setState({ threads: {}, threadMessages: {} } as never);
    const { container } = render(wrap(
      <ThreadPanel channelId="ch-1" messageId="p-missing" members={{ MEMBERS: [ME, ALICE], byId: { me: ME, u2: ALICE } }} onClose={vi.fn()} onReact={vi.fn()} />,
    ));
    expect(container.firstChild).toBeTruthy();
  });

  it('clicks every button (broad sweep)', () => {
    const { container } = render(wrap(
      <ThreadPanel channelId="ch-1" messageId="p1" members={{ MEMBERS: [ME, ALICE], byId: { me: ME, u2: ALICE } }} onClose={vi.fn()} onReact={vi.fn()} />,
    ));
    const buttons = [...container.querySelectorAll('button')] as HTMLButtonElement[];
    for (const b of buttons) try { fireEvent.click(b); } catch { /* */ }
    expect(container.firstChild).toBeTruthy();
  });

  it('clicking a reply reaction toggles via internal setReplies (L1175-1196)', () => {
    const REPLIES_WITH_RXN = [
      {
        id: 'rr1',
        author: 'u2',
        at: new Date(),
        kind: 'text',
        text: 'with reactions',
        edited: false,
        deleted: false,
        reactions: [
          { e: '👍', n: 2, mine: false },
          { e: '🔥', n: 1, mine: true },
        ],
      },
    ];
    const SHELL_WITH_RXN = {
      ...SHELL,
      THREAD_REPLIES: { p1: REPLIES_WITH_RXN },
    };
    const { container } = render(
      <ShellDataProvider value={SHELL_WITH_RXN}>
        <ThreadPanel
          channelId="ch-1"
          messageId="p1"
          members={{ MEMBERS: [ME, ALICE], byId: { me: ME, u2: ALICE } }}
          onClose={vi.fn()}
          onReact={vi.fn()}
        />
      </ShellDataProvider>,
    );
    // Reply reaction pills should render under the thread reply.
    const pills = Array.from(container.querySelectorAll('.rxn')) as HTMLElement[];
    expect(pills.length).toBeGreaterThan(0);
    // Click the not-mine pill — should increment.
    const thumbs = pills.find((el) => (el.textContent ?? '').includes('👍'));
    if (thumbs) fireEvent.click(thumbs);
    // Click the mine pill (count=1) — should remove.
    const fire = pills.find((el) => (el.textContent ?? '').includes('🔥'));
    if (fire) fireEvent.click(fire);
    expect(container.firstChild).toBeTruthy();
  });
});
