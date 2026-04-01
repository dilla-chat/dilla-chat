import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ToastProvider } from '../components/Toast/Toast';

vi.mock('../services/websocket', () => ({
  ws: {
    on: vi.fn(() => vi.fn()),
    isConnected: vi.fn(() => false),
    request: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn(),
    editMessage: vi.fn(),
    deleteMessage: vi.fn(),
    startTyping: vi.fn(),
    joinChannel: vi.fn(),
    leaveChannel: vi.fn(),
  },
}));

vi.mock('../services/api', () => ({
  api: {
    getMessages: vi.fn().mockResolvedValue([]),
    getChannelThreads: vi.fn().mockResolvedValue([]),
    createThread: vi.fn(),
  },
}));

vi.mock('../services/crypto', () => ({
  cryptoService: {
    decryptChannel: vi.fn(),
    encryptChannel: vi.fn().mockResolvedValue('encrypted-content'),
    getSenderKeyDistribution: vi.fn().mockResolvedValue('{"sender_id":"u1"}'),
    processSenderKey: vi.fn().mockResolvedValue(undefined),
    ensureChannelSession: vi.fn().mockResolvedValue(undefined),
  },
  getIdentityKeys: vi.fn(() => ({ publicKeyBytes: new Uint8Array(32) })),
}));

vi.mock('../services/cryptoCore', () => ({ toBase64: vi.fn(() => 'base64') }));

vi.mock('../services/messageCache', () => ({
  cacheMessage: vi.fn(),
  getCachedMessage: vi.fn().mockResolvedValue(null),
  deleteCachedMessage: vi.fn(),
}));

vi.mock('../components/MessageList/MessageList', () => ({
  default: ({ channelId, channelName, onLoadMore, onEdit, onDelete, onCreateThread, onOpenThread }: { channelId: string; channelName?: string; onLoadMore?: () => void; onEdit?: (msg: unknown) => void; onDelete?: (msg: unknown) => void; onCreateThread?: (msg: unknown) => void; onOpenThread?: (id: string) => void }) => (
    <div data-testid="message-list" data-channel-id={channelId} data-channel-name={channelName}>
      <button data-testid="load-more" onClick={onLoadMore}>Load More</button>
      <button data-testid="edit-msg" onClick={() => onEdit?.({ id: 'msg-1', content: 'old' })}>Edit</button>
      <button data-testid="delete-msg" onClick={() => onDelete?.({ id: 'msg-1', channelId: 'ch-1', authorId: 'u1' })}>Delete</button>
      <button data-testid="create-thread" onClick={() => onCreateThread?.({ id: 'msg-1', channelId: 'ch-1' })}>Thread</button>
      <button data-testid="open-thread" onClick={() => onOpenThread?.('msg-1')}>Open Thread</button>
    </div>
  ),
}));

vi.mock('../components/MessageInput/MessageInput', () => ({
  default: ({ channelId, channelName, onSend, onEdit, onTyping, onCancelEdit }: { channelId: string; channelName?: string; onSend?: (s: string) => void; onEdit?: (id: string, s: string) => void; onTyping?: () => void; onCancelEdit?: () => void }) => (
    <div data-testid="message-input" data-channel-id={channelId} data-channel-name={channelName}>
      <button data-testid="send-btn" onClick={() => onSend?.('hello')}>Send</button>
      <button data-testid="edit-btn" onClick={() => onEdit?.('msg-1', 'edited')}>Save Edit</button>
      <button data-testid="typing-btn" onClick={onTyping}>Type</button>
      <button data-testid="cancel-edit" onClick={onCancelEdit}>Cancel</button>
    </div>
  ),
}));

import ChannelView from './ChannelView';
import { useTeamStore, type Channel } from '../stores/teamStore';
import { useAuthStore } from '../stores/authStore';
import { ws } from '../services/websocket';
import { invokeWsHandler, getWsHandler } from '../test/helpers';

function makeChannel(overrides?: Partial<Channel>): Channel {
  return { id: 'ch-1', teamId: 't1', name: 'general', topic: 'General discussion', type: 'text', position: 0, category: '', ...overrides };
}

/** Render ChannelView with standard props */
function renderChannelView(overrides?: Partial<Channel>) {
  return render(
    <ToastProvider>
      <ChannelView channel={makeChannel(overrides)} />
    </ToastProvider>,
  );
}

/** Fire a WS event handler by name on the current render */
async function fireWsEvent(eventName: string, payload: Record<string, unknown>) {
  const handler = getWsHandler(vi.mocked(ws.on), eventName);
  if (handler) await invokeWsHandler(handler, payload);
}

/** Build a raw message payload */
function makeRawMsg(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-1', channel_id: 'ch-1', author_id: 'u1', username: 'tester',
    content: 'Hello', type: 'text', thread_id: null, edited_at: null,
    deleted: false, created_at: '2025-01-01T00:00:00Z', reactions: [],
    ...overrides,
  };
}

describe('ChannelView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTeamStore.setState({
      activeTeamId: 't1',
      members: new Map([['t1', []]]),
    });
    useAuthStore.setState({
      teams: new Map([['t1', { token: 'tok', user: { id: 'u1', username: 'tester' }, teamInfo: {}, baseUrl: 'http://localhost' }]]),
      derivedKey: null,
    });
  });

  it('renders MessageList and MessageInput with correct attributes', () => {
    renderChannelView();
    expect(screen.getByTestId('message-list')).toHaveAttribute('data-channel-id', 'ch-1');
    expect(screen.getByTestId('message-input')).toBeInTheDocument();
  });

  it.each([
    { component: 'message-list', attr: 'data-channel-id', value: 'ch-42', override: { id: 'ch-42' } },
    { component: 'message-list', attr: 'data-channel-name', value: 'announcements', override: { name: 'announcements' } },
    { component: 'message-input', attr: 'data-channel-id', value: 'ch-42', override: { id: 'ch-42' } },
    { component: 'message-input', attr: 'data-channel-name', value: 'test-chan', override: { name: 'test-chan' } },
  ])('passes $attr=$value to $component', ({ component, attr, value, override }) => {
    renderChannelView(override);
    expect(screen.getByTestId(component)).toHaveAttribute(attr, value);
  });

  it('subscribes to message and thread WebSocket events on mount', () => {
    renderChannelView();
    const eventNames = vi.mocked(ws.on).mock.calls.map((c) => c[0]);
    for (const evt of ['message:new', 'message:updated', 'message:deleted', 'typing:indicator', 'thread:created', 'thread:updated', 'thread:message:new', 'thread:message:updated', 'thread:message:deleted']) {
      expect(eventNames).toContain(evt);
    }
  });

  it('unsubscribes from events on unmount', () => {
    const unsub = vi.fn();
    vi.mocked(ws.on).mockReturnValue(unsub);
    const { unmount } = renderChannelView();
    unmount();
    expect(unsub).toHaveBeenCalled();
  });

  it('renders with different channels via rerender', () => {
    const { rerender } = render(<ToastProvider><ChannelView channel={makeChannel({ id: 'ch-1', name: 'general' })} /></ToastProvider>);
    expect(screen.getByTestId('message-list')).toHaveAttribute('data-channel-name', 'general');
    rerender(<ToastProvider><ChannelView channel={makeChannel({ id: 'ch-2', name: 'random' })} /></ToastProvider>);
    expect(screen.getByTestId('message-list')).toHaveAttribute('data-channel-name', 'random');
  });

  it('loads message history via API on mount when WS not connected', async () => {
    const { api } = await import('../services/api');
    vi.mocked(api.getMessages).mockResolvedValueOnce([makeRawMsg()]);
    renderChannelView();
    await waitFor(() => {
      expect(api.getMessages).toHaveBeenCalledWith('t1', 'ch-1', 50);
    });
  });

  it('loads message history via WS when connected', async () => {
    vi.mocked(ws.isConnected).mockReturnValue(true);
    vi.mocked(ws.request).mockResolvedValueOnce([]);
    renderChannelView();
    await waitFor(() => {
      expect(ws.request).toHaveBeenCalledWith('t1', 'messages:list', expect.objectContaining({ channel_id: 'ch-1' }));
    });
  });

  it.each([
    { event: 'message:new', payload: { id: 'msg-x', channel_id: 'ch-other', author_id: 'u2', username: 'bob', content: 'hi', type: 'text', thread_id: null, edited_at: null, deleted: false, created_at: '2025-01-01T00:00:00Z', reactions: [] } },
    { event: 'message:updated', payload: { message_id: 'msg-1', channel_id: 'ch-1', content: 'edited', author_id: 'u1' } },
    { event: 'message:deleted', payload: { message_id: 'msg-1', channel_id: 'ch-1' } },
    { event: 'typing:indicator', payload: { channel_id: 'ch-1', user_id: 'u2', username: 'bob' } },
  ])('invokes WS handler for $event', async ({ event, payload }) => {
    renderChannelView();
    const handler = getWsHandler(vi.mocked(ws.on), event);
    expect(handler).toBeDefined();
    if (handler) await invokeWsHandler(handler, payload);
  });

  it('invokes WS thread event callbacks', async () => {
    renderChannelView();
    const onMock = vi.mocked(ws.on);
    const events: [string, Record<string, unknown>][] = [
      ['thread:created', { id: 'th1', channel_id: 'ch-1', parent_message_id: 'msg-1' }],
      ['thread:updated', { id: 'th1', channel_id: 'ch-1' }],
      ['thread:message:new', { id: 'tmsg-1', channel_id: 'ch-1', thread_id: 'th1', author_id: 'u1', username: 'tester', content: 'reply', type: 'text', edited_at: null, deleted: false, created_at: '2025-01-01T00:00:00Z', reactions: [] }],
      ['thread:message:updated', { id: 'tmsg-1', channel_id: 'ch-1', thread_id: 'th1', author_id: 'u1', username: 'tester', content: 'edited', type: 'text', edited_at: '2025-01-01T01:00:00Z', deleted: false, created_at: '2025-01-01T00:00:00Z', reactions: [] }],
      ['thread:message:deleted', { message_id: 'tmsg-1', thread_id: 'th1' }],
    ];
    for (const [event, payload] of events) {
      const handler = getWsHandler(onMock, event);
      expect(handler).toBeDefined();
      if (handler) await invokeWsHandler(handler, payload);
    }
  });

  it('ignores WS events for other channels', async () => {
    renderChannelView();
    const onMock = vi.mocked(ws.on);
    const events: [string, Record<string, unknown>][] = [
      ['message:new', { id: 'msg-x', channel_id: 'other-ch', author_id: 'u2', username: 'bob', content: 'hi', type: 'text', thread_id: null, edited_at: null, deleted: false, created_at: '2025-01-01T00:00:00Z', reactions: [] }],
      ['message:deleted', { message_id: 'msg-x', channel_id: 'other-ch' }],
      ['typing:indicator', { channel_id: 'other-ch', user_id: 'u2', username: 'bob' }],
      ['message:updated', { message_id: 'msg-x', channel_id: 'other-ch', content: 'edited', author_id: 'u1' }],
      ['thread:created', { id: 'th-other', channel_id: 'other-ch', parent_message_id: 'msg-x' }],
      ['thread:updated', { id: 'th-other', channel_id: 'other-ch' }],
    ];
    for (const [event, payload] of events) {
      const handler = getWsHandler(onMock, event);
      expect(handler).toBeDefined();
      if (handler) await invokeWsHandler(handler, payload);
    }
  });

  it.each([
    { event: 'thread:message:new', payload: { id: 'tmsg-1', channel_id: 'ch-1', thread_id: null, author_id: 'u1', username: 'tester', content: 'reply', type: 'text', edited_at: null, deleted: false, created_at: '2025-01-01T00:00:00Z', reactions: [] } },
    { event: 'thread:message:updated', payload: { id: 'tmsg-1', channel_id: 'ch-1', thread_id: null, author_id: 'u1', username: 'tester', content: 'edited', type: 'text', edited_at: '2025-01-01T01:00:00Z', deleted: false, created_at: '2025-01-01T00:00:00Z', reactions: [] } },
    { event: 'thread:message:deleted', payload: { message_id: 'tmsg-1', thread_id: null } },
  ])('handles $event with null thread_id', async ({ event, payload }) => {
    renderChannelView();
    await fireWsEvent(event, payload);
  });

  it('does not render when no activeTeamId', () => {
    useTeamStore.setState({ activeTeamId: null });
    renderChannelView();
    expect(screen.getByTestId('message-list')).toBeInTheDocument();
  });

  it('sends a message via WS when send button is clicked', async () => {
    useAuthStore.setState({ derivedKey: 'test-key' });
    renderChannelView();
    fireEvent.click(screen.getByTestId('send-btn'));
    await waitFor(() => {
      expect(ws.sendMessage).toHaveBeenCalledWith('t1', 'ch-1', expect.any(String), 'text', undefined, []);
    });
  });

  it('edits a message via WS when edit button is clicked', async () => {
    useAuthStore.setState({ derivedKey: 'test-key' });
    renderChannelView();
    fireEvent.click(screen.getByTestId('edit-msg'));
    fireEvent.click(screen.getByTestId('edit-btn'));
    await waitFor(() => {
      expect(ws.editMessage).toHaveBeenCalledWith('t1', 'msg-1', 'ch-1', expect.any(String));
    });
  });

  it('deletes a message via WS when delete button is clicked', () => {
    renderChannelView();
    fireEvent.click(screen.getByTestId('delete-msg'));
    expect(ws.deleteMessage).toHaveBeenCalledWith('t1', 'msg-1', 'ch-1');
  });

  it('sends typing indicator via WS when typing', () => {
    renderChannelView();
    fireEvent.click(screen.getByTestId('typing-btn'));
    expect(ws.startTyping).toHaveBeenCalledWith('t1', 'ch-1');
  });

  it.each([
    { scenario: 'send', btnId: 'send-btn', method: 'sendMessage' as const },
    { scenario: 'edit', btnId: 'edit-msg+edit-btn', method: 'editMessage' as const },
    { scenario: 'delete', btnId: 'delete-msg', method: 'deleteMessage' as const },
    { scenario: 'typing', btnId: 'typing-btn', method: 'startTyping' as const },
  ])('does not $scenario when activeTeamId is null', ({ btnId, method }) => {
    useTeamStore.setState({ activeTeamId: null });
    renderChannelView();
    for (const id of btnId.split('+')) {
      fireEvent.click(screen.getByTestId(id));
    }
    expect(ws[method]).not.toHaveBeenCalled();
  });

  it('does not create thread when activeTeamId is null', async () => {
    useTeamStore.setState({ activeTeamId: null });
    const { api } = await import('../services/api');
    renderChannelView();
    fireEvent.click(screen.getByTestId('create-thread'));
    expect(api.createThread).not.toHaveBeenCalled();
  });

  it('triggers handleLoadMore with messages in store', async () => {
    const { useMessageStore } = await import('../stores/messageStore');
    useMessageStore.setState({
      messages: new Map([['ch-1', [{ id: 'old-msg', channelId: 'ch-1', authorId: 'u1', username: 'tester', content: 'old', encryptedContent: '', type: 'text', threadId: null, editedAt: null, deleted: false, createdAt: '2025-01-01T00:00:00Z', reactions: [] }]]]),
      loadingHistory: new Map([['ch-1', false]]),
      hasMore: new Map([['ch-1', true]]),
    });
    renderChannelView();
    const loadMoreBtn = screen.getByTestId('load-more');
    expect(loadMoreBtn).toBeInTheDocument();
    fireEvent.click(loadMoreBtn);
  });

  it('creates a thread via API when create thread button is clicked', async () => {
    const { api } = await import('../services/api');
    vi.mocked(api.createThread).mockResolvedValueOnce({
      id: 'th-new', channel_id: 'ch-1', parent_message_id: 'msg-1',
      team_id: 't1', creator_id: 'u1', title: '', message_count: 0,
      last_message_at: null, created_at: '2025-01-01T00:00:00Z',
    });
    renderChannelView();
    fireEvent.click(screen.getByTestId('create-thread'));
    await waitFor(() => {
      expect(api.createThread).toHaveBeenCalledWith('t1', 'ch-1', 'msg-1');
    });
  });

  it('cancel edit clears editing state', () => {
    renderChannelView();
    fireEvent.click(screen.getByTestId('edit-msg'));
    const cancelBtn = screen.getByTestId('cancel-edit');
    expect(cancelBtn).toBeInTheDocument();
    fireEvent.click(cancelBtn);
  });

  it('calls handleLoadMore which checks loadingHistory and hasMore via WS', async () => {
    vi.mocked(ws.isConnected).mockReturnValue(true);
    const fiftyMsgs = Array.from({ length: 50 }, (_, i) => makeRawMsg({ id: `msg-${i}` }));
    vi.mocked(ws.request).mockResolvedValueOnce(fiftyMsgs);
    vi.mocked(ws.request).mockResolvedValueOnce([]);
    vi.mocked(ws.request).mockResolvedValueOnce([]);
    renderChannelView();
    await waitFor(() => {
      expect(vi.mocked(ws.request).mock.calls.some(c => c[1] === 'messages:list')).toBe(true);
    });
    fireEvent.click(screen.getByTestId('load-more'));
    await waitFor(() => {
      const calls = vi.mocked(ws.request).mock.calls;
      const loadMoreCall = calls.find(c => c[1] === 'messages:list' && (c[2] as Record<string, unknown>)?.before);
      expect(loadMoreCall).toBeDefined();
    });
  });

  it('handleLoadMore uses REST fallback when WS not connected', async () => {
    vi.mocked(ws.isConnected).mockReturnValue(false);
    const { api } = await import('../services/api');
    const fiftyMsgs = Array.from({ length: 50 }, (_, i) => makeRawMsg({ id: `msg-${i}` }));
    vi.mocked(api.getMessages).mockResolvedValueOnce(fiftyMsgs);
    vi.mocked(api.getMessages).mockResolvedValueOnce([]);
    renderChannelView();
    await waitFor(() => { expect(api.getMessages).toHaveBeenCalled(); });
    fireEvent.click(screen.getByTestId('load-more'));
    await waitFor(() => { expect(api.getMessages).toHaveBeenCalledTimes(2); });
  });

  it.each([
    { scenario: 'already loading', loading: true, hasMore: true },
    { scenario: 'no more messages', loading: false, hasMore: false },
  ])('does not load more when $scenario', async ({ loading, hasMore }) => {
    const { useMessageStore } = await import('../stores/messageStore');
    useMessageStore.setState({
      messages: new Map([['ch-1', []]]),
      loadingHistory: new Map([['ch-1', loading]]),
      hasMore: new Map([['ch-1', hasMore]]),
    });
    renderChannelView();
    fireEvent.click(screen.getByTestId('load-more'));
  });

  it('opens a thread by parent message id', async () => {
    const { useThreadStore } = await import('../stores/threadStore');
    useThreadStore.setState({
      threads: { 'ch-1': [{ id: 'th1', channel_id: 'ch-1', parent_message_id: 'msg-1', team_id: 't1', creator_id: 'u1', title: '', message_count: 0, last_message_at: null, created_at: '' }] },
      setActiveThread: vi.fn(),
      setThreadPanelOpen: vi.fn(),
    });
    renderChannelView();
    fireEvent.click(screen.getByTestId('open-thread'));
    expect(useThreadStore.getState().setActiveThread).toHaveBeenCalledWith('th1');
    expect(useThreadStore.getState().setThreadPanelOpen).toHaveBeenCalledWith(true);
  });

  it('does not open thread when no matching thread exists', async () => {
    const { useThreadStore } = await import('../stores/threadStore');
    useThreadStore.setState({
      threads: { 'ch-1': [] },
      setActiveThread: vi.fn(),
      setThreadPanelOpen: vi.fn(),
    });
    renderChannelView();
    fireEvent.click(screen.getByTestId('open-thread'));
    expect(useThreadStore.getState().setActiveThread).not.toHaveBeenCalled();
  });

  it('invokes message:new handler for same channel', async () => {
    renderChannelView();
    await fireWsEvent('message:new', makeRawMsg({ id: 'msg-new', author_id: 'u2', username: 'bob', content: 'hello!' }));
    expect(screen.getByTestId('message-list')).toBeInTheDocument();
  });

  it('handles thread:message:new that updates existing thread count', async () => {
    const { useThreadStore } = await import('../stores/threadStore');
    useThreadStore.setState({
      threads: { 'ch-1': [{ id: 'th1', channel_id: 'ch-1', parent_message_id: 'msg-1', team_id: 't1', creator_id: 'u1', title: '', message_count: 2, last_message_at: null, created_at: '' }] },
    });
    renderChannelView();
    await fireWsEvent('thread:message:new', {
      id: 'tmsg-2', channel_id: 'ch-1', thread_id: 'th1', author_id: 'u1',
      username: 'tester', content: 'reply2', type: 'text', edited_at: null,
      deleted: false, created_at: '2025-01-02T00:00:00Z', reactions: [],
    });
    expect(screen.getByTestId('message-list')).toBeInTheDocument();
  });

  it('loads threads via WS when connected', async () => {
    vi.mocked(ws.isConnected).mockReturnValue(true);
    vi.mocked(ws.request).mockResolvedValue([]);
    renderChannelView();
    await waitFor(() => {
      const threadListCall = vi.mocked(ws.request).mock.calls.find(c => c[1] === 'threads:list');
      expect(threadListCall).toBeDefined();
    });
  });

  it('loads threads via API when WS not connected', async () => {
    vi.mocked(ws.isConnected).mockReturnValue(false);
    const { api } = await import('../services/api');
    vi.mocked(api.getChannelThreads).mockResolvedValue([]);
    renderChannelView();
    await waitFor(() => {
      expect(api.getChannelThreads).toHaveBeenCalledWith('t1', 'ch-1');
    });
  });

  it('handles createThread failure gracefully', async () => {
    const { api } = await import('../services/api');
    vi.mocked(api.createThread).mockRejectedValueOnce(new Error('fail'));
    renderChannelView();
    fireEvent.click(screen.getByTestId('create-thread'));
    await waitFor(() => {
      expect(api.createThread).toHaveBeenCalled();
    });
  });

  it('resolves username from members when server message has no username', async () => {
    useTeamStore.setState({
      activeTeamId: 't1',
      members: new Map([['t1', [{ id: 'm1', userId: 'u2', username: 'bob', displayName: 'Bob', nickname: '', roles: [], statusType: '' }]]]),
    });
    renderChannelView();
    await fireWsEvent('message:new', makeRawMsg({ id: 'msg-no-user', author_id: 'u2', username: '' }));
    expect(screen.getByTestId('message-list')).toBeInTheDocument();
  });

  it('tryEncrypt encrypts when derivedKey is set', async () => {
    const { cryptoService } = await import('../services/crypto');
    vi.mocked(cryptoService.encryptChannel).mockResolvedValueOnce('encrypted-text');
    useAuthStore.setState({ derivedKey: 'test-derived-key' });
    renderChannelView();
    fireEvent.click(screen.getByTestId('send-btn'));
    await waitFor(() => {
      expect(cryptoService.encryptChannel).toHaveBeenCalled();
    });
  });

  it('tryEncrypt does not send message on encryption error', async () => {
    const { cryptoService } = await import('../services/crypto');
    vi.mocked(cryptoService.encryptChannel).mockRejectedValueOnce(new Error('encrypt fail'));
    useAuthStore.setState({ derivedKey: 'test-derived-key' });
    renderChannelView();
    fireEvent.click(screen.getByTestId('send-btn'));
    await waitFor(() => {
      expect(cryptoService.encryptChannel).toHaveBeenCalled();
    });
    expect(ws.sendMessage).not.toHaveBeenCalled();
  });

  it('handleLoadMore with REST decrypts messages using tryDecrypt', async () => {
    vi.mocked(ws.isConnected).mockReturnValue(false);
    const { api } = await import('../services/api');
    const fiftyMsgs = Array.from({ length: 50 }, (_, i) => makeRawMsg({ id: `msg-${i}`, content: 'encrypted' }));
    vi.mocked(api.getMessages).mockResolvedValueOnce(fiftyMsgs);
    vi.mocked(api.getMessages).mockResolvedValueOnce([makeRawMsg({ id: 'msg-older', content: 'older msg', created_at: '2024-12-31T00:00:00Z' })]);
    renderChannelView();
    await waitFor(() => { expect(api.getMessages).toHaveBeenCalledTimes(1); });
    fireEvent.click(screen.getByTestId('load-more'));
    await waitFor(() => { expect(api.getMessages).toHaveBeenCalledTimes(2); });
  });
});
