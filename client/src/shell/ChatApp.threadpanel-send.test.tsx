// ThreadPanel send() with isMockSession=false so the real-send branch
// (L1101-1119) runs: createThread, ws.sendThreadMessage, error handling.

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

const wsMock = vi.hoisted(() => ({
  ws: { sendThreadMessage: vi.fn() },
}));
vi.mock('../services/websocket', () => wsMock);

const apiMock = vi.hoisted(() => ({
  api: {
    createThread: vi.fn(async () => ({ id: 'thr-1' })),
  },
}));
vi.mock('../services/api', () => ({ api: apiMock.api }));
vi.mock('../services/mockSession', () => ({ isMockSession: () => false }));
vi.mock('../hooks/useMessageDecryption', () => ({
  tryEncrypt: vi.fn(async (s: string) => 'enc:' + s),
  tryDecrypt: vi.fn(async (_id: string, c: string) => c),
  serverToMessage: vi.fn((m) => m),
}));
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

import { ThreadPanel } from './ChatApp';
import { ShellDataProvider } from './ShellDataContext';
import { useTeamStore } from '../stores/teamStore';
import { useAuthStore } from '../stores/authStore';
import { useThreadStore } from '../stores/threadStore';
import { useMessageStore } from '../stores/messageStore';

const ME = { id: 'me', name: 'me', initials: 'ME', color: '#f00' };
const ALICE = { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0' };
const PARENT = { id: 'p1', author: 'me', at: new Date(), kind: 'text', text: 'parent', edited: false, deleted: false };

const SHELL = {
  SERVERS: [{ id: 't1', name: 'Acme' }],
  CHANNELS: [{ id: 'ch-1', name: 'general', type: 'text' }],
  MEMBERS: [ME, ALICE],
  byId: { me: ME, u2: ALICE },
  MESSAGES: { 'ch-1': [PARENT] },
  DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: { p1: [] },
  activeServerId: 't1', activeChannelId: 'ch-1', currentUserId: 'me',
};

function wrap(c: React.ReactNode) {
  return <ShellDataProvider value={SHELL}>{c}</ShellDataProvider>;
}

beforeEach(() => {
  wsMock.ws.sendThreadMessage.mockClear();
  apiMock.api.createThread.mockClear();
  (window as unknown as { SHELL_DATA?: { currentUserId?: string } }).SHELL_DATA = {
    currentUserId: 'me',
  };
  useTeamStore.setState({ activeTeamId: 't1', activeChannelId: 'ch-1' } as never);
  useAuthStore.setState({ derivedKey: 'k', teams: new Map([['t1', { user: { id: 'me' } }]]) } as never);
  useThreadStore.setState({
    threads: { 'ch-1': [] },
    threadMessages: { p1: [] },
    addThread: vi.fn(),
  } as never);
  useMessageStore.setState({ messages: new Map([['ch-1', [PARENT]]]), typing: new Map(), hasMore: new Map(), loadingHistory: new Map() } as never);
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('ThreadPanel send() — real session', () => {
  const members = { MEMBERS: [ME, ALICE], byId: { me: ME, u2: ALICE } };

  it('first reply creates thread + sends encrypted message', async () => {
    const { container } = render(wrap(
      <ThreadPanel channelId="ch-1" messageId="p1" members={members} onClose={vi.fn()} onReact={vi.fn()} />,
    ));
    const ta = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(ta, { target: { value: 'hi thread' } });
      fireEvent.keyDown(ta, { key: 'Enter' });
      await flush();
    });
    expect(apiMock.api.createThread).toHaveBeenCalled();
    expect(wsMock.ws.sendThreadMessage).toHaveBeenCalled();
  });

  it('reply on existing thread reuses thread id (no createThread)', async () => {
    useThreadStore.setState({
      threads: { 'ch-1': [{ id: 'thr-existing', parent_message_id: 'p1' }] },
      threadMessages: { p1: [] },
      addThread: vi.fn(),
    } as never);
    const { container } = render(wrap(
      <ThreadPanel channelId="ch-1" messageId="p1" members={{ MEMBERS: [ME, ALICE], byId: { me: ME, u2: ALICE } }} onClose={vi.fn()} onReact={vi.fn()} />,
    ));
    const ta = container.querySelector('textarea') as HTMLTextAreaElement;
    act(() => fireEvent.change(ta, { target: { value: 'reuse' } }));
    act(() => fireEvent.keyDown(ta, { key: 'Enter' }));
    await flush();
    expect(apiMock.api.createThread).not.toHaveBeenCalled();
    expect(wsMock.ws.sendThreadMessage).toHaveBeenCalled();
  });

  it('createThread error is swallowed (no crash)', async () => {
    apiMock.api.createThread.mockRejectedValueOnce(new Error('boom'));
    const { container } = render(wrap(
      <ThreadPanel channelId="ch-1" messageId="p1" members={{ MEMBERS: [ME, ALICE], byId: { me: ME, u2: ALICE } }} onClose={vi.fn()} onReact={vi.fn()} />,
    ));
    const ta = container.querySelector('textarea') as HTMLTextAreaElement;
    act(() => fireEvent.change(ta, { target: { value: 'oops' } }));
    act(() => fireEvent.keyDown(ta, { key: 'Enter' }));
    await flush();
    // Reaching here without throwing is the test (catch block in send).
    expect(container.firstChild).toBeTruthy();
  });

  it('empty draft is a no-op (no createThread + no ws send)', () => {
    const { container } = render(wrap(
      <ThreadPanel channelId="ch-1" messageId="p1" members={{ MEMBERS: [ME, ALICE], byId: { me: ME, u2: ALICE } }} onClose={vi.fn()} onReact={vi.fn()} />,
    ));
    const ta = container.querySelector('textarea') as HTMLTextAreaElement;
    act(() => fireEvent.keyDown(ta, { key: 'Enter' }));
    expect(apiMock.api.createThread).not.toHaveBeenCalled();
    expect(wsMock.ws.sendThreadMessage).not.toHaveBeenCalled();
  });
});
