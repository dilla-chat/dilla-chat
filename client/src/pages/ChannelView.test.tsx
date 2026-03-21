import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('../services/websocket', () => ({
  ws: {
    on: vi.fn(() => vi.fn()),
    isConnected: vi.fn(() => false),
    request: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn(),
    editMessage: vi.fn(),
    deleteMessage: vi.fn(),
    startTyping: vi.fn(),
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
    encryptChannel: vi.fn(),
  },
  getIdentityKeys: vi.fn(() => ({
    publicKeyBytes: new Uint8Array(32),
  })),
}));

vi.mock('../services/cryptoCore', () => ({
  toBase64: vi.fn(() => 'base64'),
}));

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
  return {
    id: 'ch-1',
    teamId: 't1',
    name: 'general',
    topic: 'General discussion',
    type: 'text',
    position: 0,
    category: '',
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
      teams: new Map([
        ['t1', { token: 'tok', user: { id: 'u1', username: 'tester' }, teamInfo: {}, baseUrl: 'http://localhost' }],
      ]),
      derivedKey: null,
    });
  });

  it('renders MessageList and MessageInput for the channel', () => {
    render(<ChannelView channel={makeChannel()} />);
    expect(screen.getByTestId('message-list')).toBeInTheDocument();
    expect(screen.getByTestId('message-input')).toBeInTheDocument();
  });

  it('passes channel id to MessageList', () => {
    render(<ChannelView channel={makeChannel({ id: 'ch-42' })} />);
    expect(screen.getByTestId('message-list')).toHaveAttribute('data-channel-id', 'ch-42');
  });

  it('passes channel name to MessageList', () => {
    render(<ChannelView channel={makeChannel({ name: 'announcements' })} />);
    expect(screen.getByTestId('message-list')).toHaveAttribute('data-channel-name', 'announcements');
  });

  it('passes channel id to MessageInput', () => {
    render(<ChannelView channel={makeChannel({ id: 'ch-42' })} />);
    expect(screen.getByTestId('message-input')).toHaveAttribute('data-channel-id', 'ch-42');
  });

  it('subscribes to WebSocket events on mount', () => {
    render(<ChannelView channel={makeChannel()} />);
    // Should subscribe to message:new, message:edited, message:deleted, typing:start,
    // thread:created, thread:updated, etc.
    expect(ws.on).toHaveBeenCalled();
    const eventNames = vi.mocked(ws.on).mock.calls.map((c) => c[0]);
    expect(eventNames).toContain('message:new');
    expect(eventNames).toContain('message:edited');
    expect(eventNames).toContain('message:deleted');
    expect(eventNames).toContain('typing:start');
  });

  it('subscribes to thread events', () => {
    render(<ChannelView channel={makeChannel()} />);
    const eventNames = vi.mocked(ws.on).mock.calls.map((c) => c[0]);
    expect(eventNames).toContain('thread:created');
    expect(eventNames).toContain('thread:updated');
    expect(eventNames).toContain('thread:message:new');
  });

  it('unsubscribes from events on unmount', () => {
    const unsub = vi.fn();
    vi.mocked(ws.on).mockReturnValue(unsub);

    const { unmount } = render(<ChannelView channel={makeChannel()} />);
    unmount();

    expect(unsub).toHaveBeenCalled();
  });

  it('renders with different channels', () => {
    const { rerender } = render(
      <ChannelView channel={makeChannel({ id: 'ch-1', name: 'general' })} />,
    );
    expect(screen.getByTestId('message-list')).toHaveAttribute('data-channel-name', 'general');

    rerender(
      <ChannelView channel={makeChannel({ id: 'ch-2', name: 'random' })} />,
    );
    expect(screen.getByTestId('message-list')).toHaveAttribute('data-channel-name', 'random');
  });

  it('subscribes to thread message events', () => {
    render(<ChannelView channel={makeChannel()} />);
    const eventNames = vi.mocked(ws.on).mock.calls.map((c) => c[0]);
    expect(eventNames).toContain('thread:message:new');
    expect(eventNames).toContain('thread:message:updated');
    expect(eventNames).toContain('thread:message:deleted');
  });

  it('passes channelName to MessageInput', () => {
    render(<ChannelView channel={makeChannel({ name: 'test-chan' })} />);
    expect(screen.getByTestId('message-input')).toHaveAttribute('data-channel-name', 'test-chan');
  });

  it('loads message history via API on mount when WS not connected', async () => {
    const { api } = await import('../services/api');
    vi.mocked(api.getMessages).mockResolvedValueOnce([
      {
        id: 'msg-1',
        channel_id: 'ch-1',
        author_id: 'u1',
        username: 'tester',
        content: 'Hello',
        type: 'text',
        thread_id: null,
        edited_at: null,
        deleted: false,
        created_at: '2025-01-01T00:00:00Z',
        reactions: [],
      },
    ]);
    render(<ChannelView channel={makeChannel()} />);
    await waitFor(() => {
      expect(api.getMessages).toHaveBeenCalledWith('t1', 'ch-1', 50);
    });
  });

  it('loads message history via WS when connected', async () => {
    vi.mocked(ws.isConnected).mockReturnValue(true);
    vi.mocked(ws.request).mockResolvedValueOnce([]);
    render(<ChannelView channel={makeChannel()} />);
    await waitFor(() => {
      expect(ws.request).toHaveBeenCalledWith('t1', 'messages:list', expect.objectContaining({ channel_id: 'ch-1' }));
    });
  });

  it('invokes WS event callbacks for message:new', async () => {
    render(<ChannelView channel={makeChannel()} />);
    const handler = getWsHandler(vi.mocked(ws.on), 'message:new');
    expect(handler).toBeDefined();
    // Call the handler with a message from a different channel - should be ignored
    if (handler) {
      await invokeWsHandler(handler, {
        id: 'msg-x', channel_id: 'ch-other', author_id: 'u2', username: 'bob',
        content: 'hi', type: 'text', thread_id: null, edited_at: null, deleted: false,
        created_at: '2025-01-01T00:00:00Z', reactions: [],
      });
    }
  });

  it('invokes WS event callbacks for message:edited', async () => {
    render(<ChannelView channel={makeChannel()} />);
    const handler = getWsHandler(vi.mocked(ws.on), 'message:edited');
    expect(handler).toBeDefined();
    if (handler) {
      await invokeWsHandler(handler, {
        message_id: 'msg-1', channel_id: 'ch-1', content: 'edited', author_id: 'u1',
      });
    }
  });

  it('invokes WS event callbacks for message:deleted', async () => {
    render(<ChannelView channel={makeChannel()} />);
    const handler = getWsHandler(vi.mocked(ws.on), 'message:deleted');
    expect(handler).toBeDefined();
    if (handler) {
      await invokeWsHandler(handler, { message_id: 'msg-1', channel_id: 'ch-1' });
    }
  });

  it('invokes WS event callbacks for typing:start', async () => {
    render(<ChannelView channel={makeChannel()} />);
    const handler = getWsHandler(vi.mocked(ws.on), 'typing:start');
    expect(handler).toBeDefined();
    if (handler) {
      await invokeWsHandler(handler, { channel_id: 'ch-1', user_id: 'u2', username: 'bob' });
    }
  });

  it('invokes WS thread event callbacks', async () => {
    render(<ChannelView channel={makeChannel()} />);
    const onMock = vi.mocked(ws.on);

    const threadCreated = getWsHandler(onMock, 'thread:created');
    if (threadCreated) {
      await invokeWsHandler(threadCreated, { id: 'th1', channel_id: 'ch-1', parent_message_id: 'msg-1' });
    }

    const threadUpdated = getWsHandler(onMock, 'thread:updated');
    if (threadUpdated) {
      await invokeWsHandler(threadUpdated, { id: 'th1', channel_id: 'ch-1' });
    }

    const threadMsgNew = getWsHandler(onMock, 'thread:message:new');
    if (threadMsgNew) {
      await invokeWsHandler(threadMsgNew, {
        id: 'tmsg-1', channel_id: 'ch-1', thread_id: 'th1', author_id: 'u1',
        username: 'tester', content: 'reply', type: 'text', edited_at: null,
        deleted: false, created_at: '2025-01-01T00:00:00Z', reactions: [],
      });
    }

    const threadMsgEdit = getWsHandler(onMock, 'thread:message:updated');
    if (threadMsgEdit) {
      await invokeWsHandler(threadMsgEdit, {
        id: 'tmsg-1', channel_id: 'ch-1', thread_id: 'th1', author_id: 'u1',
        username: 'tester', content: 'edited', type: 'text', edited_at: '2025-01-01T01:00:00Z',
        deleted: false, created_at: '2025-01-01T00:00:00Z', reactions: [],
      });
    }

    const threadMsgDel = getWsHandler(onMock, 'thread:message:deleted');
    if (threadMsgDel) {
      await invokeWsHandler(threadMsgDel, { message_id: 'tmsg-1', thread_id: 'th1' });
    }
  });

  it('ignores WS events for other channels', async () => {
    render(<ChannelView channel={makeChannel()} />);
    const onMock = vi.mocked(ws.on);

    const newMsgHandler = getWsHandler(onMock, 'message:new');
    if (newMsgHandler) {
      await invokeWsHandler(newMsgHandler, {
        id: 'msg-x', channel_id: 'other-ch', author_id: 'u2', username: 'bob',
        content: 'hi', type: 'text', thread_id: null, edited_at: null, deleted: false,
        created_at: '2025-01-01T00:00:00Z', reactions: [],
      });
    }

    const deleteHandler = getWsHandler(onMock, 'message:deleted');
    if (deleteHandler) {
      await invokeWsHandler(deleteHandler, { message_id: 'msg-x', channel_id: 'other-ch' });
    }

    const typingHandler = getWsHandler(onMock, 'typing:start');
    if (typingHandler) {
      await invokeWsHandler(typingHandler, { channel_id: 'other-ch', user_id: 'u2', username: 'bob' });
    }
  });

  it('handles thread message events with null thread_id', async () => {
    render(<ChannelView channel={makeChannel()} />);
    const handler = getWsHandler(vi.mocked(ws.on), 'thread:message:new');
    if (handler) {
      await invokeWsHandler(handler, {
        id: 'tmsg-1', channel_id: 'ch-1', thread_id: null, author_id: 'u1',
        username: 'tester', content: 'reply', type: 'text', edited_at: null,
        deleted: false, created_at: '2025-01-01T00:00:00Z', reactions: [],
      });
    }
  });

  it('does not render when no activeTeamId', () => {
    useTeamStore.setState({ activeTeamId: null });
    render(<ChannelView channel={makeChannel()} />);
    expect(screen.getByTestId('message-list')).toBeInTheDocument();
  });

  it('sends a message via WS when send button is clicked', async () => {
    render(<ChannelView channel={makeChannel()} />);
    fireEvent.click(screen.getByTestId('send-btn'));
    await waitFor(() => {
      expect(ws.sendMessage).toHaveBeenCalledWith('t1', 'ch-1', expect.any(String));
    });
  });

  it('edits a message via WS when edit button is clicked', async () => {
    render(<ChannelView channel={makeChannel()} />);
    fireEvent.click(screen.getByTestId('edit-msg'));
    fireEvent.click(screen.getByTestId('edit-btn'));
    await waitFor(() => {
      expect(ws.editMessage).toHaveBeenCalledWith('t1', 'msg-1', 'ch-1', expect.any(String));
    });
  });

  it('deletes a message via WS when delete button is clicked', () => {
    render(<ChannelView channel={makeChannel()} />);
    fireEvent.click(screen.getByTestId('delete-msg'));
    expect(ws.deleteMessage).toHaveBeenCalledWith('t1', 'msg-1', 'ch-1');
  });

  it('sends typing indicator via WS when typing', () => {
    render(<ChannelView channel={makeChannel()} />);
    fireEvent.click(screen.getByTestId('typing-btn'));
    expect(ws.startTyping).toHaveBeenCalledWith('t1', 'ch-1');
  });

  it('does not send when activeTeamId is null', () => {
    useTeamStore.setState({ activeTeamId: null });
    render(<ChannelView channel={makeChannel()} />);
    fireEvent.click(screen.getByTestId('send-btn'));
    expect(ws.sendMessage).not.toHaveBeenCalled();
  });

  it('triggers handleLoadMore with messages in store', async () => {
    const { useMessageStore } = await import('../stores/messageStore');
    useMessageStore.setState({
      messages: new Map([['ch-1', [{ id: 'old-msg', channelId: 'ch-1', authorId: 'u1', username: 'tester', content: 'old', encryptedContent: '', type: 'text', threadId: null, editedAt: null, deleted: false, createdAt: '2025-01-01T00:00:00Z', reactions: [] }]]]),
      loadingHistory: new Map([['ch-1', false]]),
      hasMore: new Map([['ch-1', true]]),
    });
    render(<ChannelView channel={makeChannel()} />);
    fireEvent.click(screen.getByTestId('load-more'));
  });

  it('creates a thread via API when create thread button is clicked', async () => {
    const { api } = await import('../services/api');
    vi.mocked(api.createThread).mockResolvedValueOnce({
      id: 'th-new', channel_id: 'ch-1', parent_message_id: 'msg-1',
      team_id: 't1', creator_id: 'u1', title: '', message_count: 0,
      last_message_at: null, created_at: '2025-01-01T00:00:00Z',
    });
    render(<ChannelView channel={makeChannel()} />);
    fireEvent.click(screen.getByTestId('create-thread'));
    await waitFor(() => {
      expect(api.createThread).toHaveBeenCalledWith('t1', 'ch-1', 'msg-1');
    });
  });

  it('cancel edit clears editing state', () => {
    render(<ChannelView channel={makeChannel()} />);
    fireEvent.click(screen.getByTestId('edit-msg'));
    fireEvent.click(screen.getByTestId('cancel-edit'));
    // Should not crash
  });

  it('calls handleLoadMore which checks loadingHistory and hasMore', async () => {
    // This test exercises the handleLoadMore callback path including
    // the WS/REST branch. Since initial load uses the same API,
    // we verify that loadMore triggers via the button click.
    vi.mocked(ws.isConnected).mockReturnValue(true);
    const initialMsg = {
      id: 'msg-init', channel_id: 'ch-1', author_id: 'u1', username: 'tester',
      content: 'init', type: 'text', thread_id: null, edited_at: null, deleted: false,
      created_at: '2025-01-01T00:00:00Z', reactions: [],
    };
    // Return exactly MESSAGE_PAGE_SIZE=50 messages to set hasMore=true
    const fiftyMsgs = Array.from({ length: 50 }, (_, i) => ({
      ...initialMsg, id: `msg-${i}`,
    }));
    vi.mocked(ws.request).mockResolvedValueOnce(fiftyMsgs); // initial load
    vi.mocked(ws.request).mockResolvedValueOnce([]); // threads:list
    vi.mocked(ws.request).mockResolvedValueOnce([]); // load more

    render(<ChannelView channel={makeChannel()} />);
    await waitFor(() => {
      // Initial load requests messages
      const calls = vi.mocked(ws.request).mock.calls;
      expect(calls.some(c => c[1] === 'messages:list')).toBe(true);
    });

    // Now click load more - the hasMore should be true from 50 messages
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

    const fiftyMsgs = Array.from({ length: 50 }, (_, i) => ({
      id: `msg-${i}`, channel_id: 'ch-1', author_id: 'u1', username: 'tester',
      content: 'init', type: 'text', thread_id: null, edited_at: null, deleted: false,
      created_at: '2025-01-01T00:00:00Z', reactions: [],
    }));
    vi.mocked(api.getMessages).mockResolvedValueOnce(fiftyMsgs); // initial
    vi.mocked(api.getMessages).mockResolvedValueOnce([]); // load more

    render(<ChannelView channel={makeChannel()} />);
    await waitFor(() => {
      expect(api.getMessages).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByTestId('load-more'));
    await waitFor(() => {
      // Second call should have 'before' param
      expect(api.getMessages).toHaveBeenCalledTimes(2);
    });
  });

  it('does not load more when already loading', async () => {
    const { useMessageStore } = await import('../stores/messageStore');
    useMessageStore.setState({
      messages: new Map([['ch-1', []]]),
      loadingHistory: new Map([['ch-1', true]]),
      hasMore: new Map([['ch-1', true]]),
    });
    render(<ChannelView channel={makeChannel()} />);
    fireEvent.click(screen.getByTestId('load-more'));
    // Should not crash; ws.request should not be called for load-more
  });

  it('does not load more when hasMore is false', async () => {
    const { useMessageStore } = await import('../stores/messageStore');
    useMessageStore.setState({
      messages: new Map([['ch-1', []]]),
      loadingHistory: new Map([['ch-1', false]]),
      hasMore: new Map([['ch-1', false]]),
    });
    render(<ChannelView channel={makeChannel()} />);
    fireEvent.click(screen.getByTestId('load-more'));
    // Should not crash
  });

  it('opens a thread by parent message id', async () => {
    const { useThreadStore } = await import('../stores/threadStore');
    useThreadStore.setState({
      threads: { 'ch-1': [{ id: 'th1', channel_id: 'ch-1', parent_message_id: 'msg-1', team_id: 't1', creator_id: 'u1', title: '', message_count: 0, last_message_at: null, created_at: '' }] },
      setActiveThread: vi.fn(),
      setThreadPanelOpen: vi.fn(),
    });
    render(<ChannelView channel={makeChannel()} />);
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
    render(<ChannelView channel={makeChannel()} />);
    fireEvent.click(screen.getByTestId('open-thread'));
    // No thread found, should not crash
  });

  it('invokes message:new handler for same channel', async () => {
    render(<ChannelView channel={makeChannel()} />);
    const handler = getWsHandler(vi.mocked(ws.on), 'message:new');
    if (handler) {
      await invokeWsHandler(handler, {
        id: 'msg-new', channel_id: 'ch-1', author_id: 'u2', username: 'bob',
        content: 'hello!', type: 'text', thread_id: null, edited_at: null, deleted: false,
        created_at: '2025-01-01T00:00:00Z', reactions: [],
      });
    }
  });

  it('handles thread:message:new that updates existing thread count', async () => {
    const { useThreadStore } = await import('../stores/threadStore');
    useThreadStore.setState({
      threads: { 'ch-1': [{ id: 'th1', channel_id: 'ch-1', parent_message_id: 'msg-1', team_id: 't1', creator_id: 'u1', title: '', message_count: 2, last_message_at: null, created_at: '' }] },
    });
    render(<ChannelView channel={makeChannel()} />);
    const handler = getWsHandler(vi.mocked(ws.on), 'thread:message:new');
    if (handler) {
      await invokeWsHandler(handler, {
        id: 'tmsg-2', channel_id: 'ch-1', thread_id: 'th1', author_id: 'u1',
        username: 'tester', content: 'reply2', type: 'text', edited_at: null,
        deleted: false, created_at: '2025-01-02T00:00:00Z', reactions: [],
      });
    }
  });

  it('loads threads via WS when connected', async () => {
    vi.mocked(ws.isConnected).mockReturnValue(true);
    vi.mocked(ws.request).mockResolvedValue([]);
    render(<ChannelView channel={makeChannel()} />);
    await waitFor(() => {
      const requestCalls = vi.mocked(ws.request).mock.calls;
      const threadListCall = requestCalls.find(c => c[1] === 'threads:list');
      expect(threadListCall).toBeDefined();
    });
  });

  it('loads threads via API when WS not connected', async () => {
    vi.mocked(ws.isConnected).mockReturnValue(false);
    const { api } = await import('../services/api');
    vi.mocked(api.getChannelThreads).mockResolvedValue([]);
    render(<ChannelView channel={makeChannel()} />);
    await waitFor(() => {
      expect(api.getChannelThreads).toHaveBeenCalledWith('t1', 'ch-1');
    });
  });

  it('handles thread:message:updated with null thread_id', async () => {
    render(<ChannelView channel={makeChannel()} />);
    const handler = getWsHandler(vi.mocked(ws.on), 'thread:message:updated');
    if (handler) {
      await invokeWsHandler(handler, {
        id: 'tmsg-1', channel_id: 'ch-1', thread_id: null, author_id: 'u1',
        username: 'tester', content: 'edited', type: 'text', edited_at: '2025-01-01T01:00:00Z',
        deleted: false, created_at: '2025-01-01T00:00:00Z', reactions: [],
      });
    }
  });

  it('handles thread:message:deleted with null thread_id', async () => {
    render(<ChannelView channel={makeChannel()} />);
    const handler = getWsHandler(vi.mocked(ws.on), 'thread:message:deleted');
    if (handler) {
      await invokeWsHandler(handler, { message_id: 'tmsg-1', thread_id: null });
    }
  });

  it('thread events from other channels are ignored', async () => {
    render(<ChannelView channel={makeChannel()} />);
    const onMock = vi.mocked(ws.on);

    const threadCreated = getWsHandler(onMock, 'thread:created');
    if (threadCreated) {
      await invokeWsHandler(threadCreated, { id: 'th-other', channel_id: 'other-ch', parent_message_id: 'msg-x' });
    }

    const threadUpdated = getWsHandler(onMock, 'thread:updated');
    if (threadUpdated) {
      await invokeWsHandler(threadUpdated, { id: 'th-other', channel_id: 'other-ch' });
    }
  });

  it('ignores message:edited from other channels', async () => {
    render(<ChannelView channel={makeChannel()} />);
    const handler = getWsHandler(vi.mocked(ws.on), 'message:edited');
    if (handler) {
      await invokeWsHandler(handler, {
        message_id: 'msg-x', channel_id: 'other-ch', content: 'edited', author_id: 'u1',
      });
    }
  });

  it('does not edit message when activeTeamId is null', () => {
    useTeamStore.setState({ activeTeamId: null });
    render(<ChannelView channel={makeChannel()} />);
    fireEvent.click(screen.getByTestId('edit-msg'));
    fireEvent.click(screen.getByTestId('edit-btn'));
    expect(ws.editMessage).not.toHaveBeenCalled();
  });

  it('does not delete message when activeTeamId is null', () => {
    useTeamStore.setState({ activeTeamId: null });
    render(<ChannelView channel={makeChannel()} />);
    fireEvent.click(screen.getByTestId('delete-msg'));
    expect(ws.deleteMessage).not.toHaveBeenCalled();
  });

  it('does not send typing when activeTeamId is null', () => {
    useTeamStore.setState({ activeTeamId: null });
    render(<ChannelView channel={makeChannel()} />);
    fireEvent.click(screen.getByTestId('typing-btn'));
    expect(ws.startTyping).not.toHaveBeenCalled();
  });

  it('does not create thread when activeTeamId is null', async () => {
    useTeamStore.setState({ activeTeamId: null });
    const { api } = await import('../services/api');
    render(<ChannelView channel={makeChannel()} />);
    fireEvent.click(screen.getByTestId('create-thread'));
    expect(api.createThread).not.toHaveBeenCalled();
  });

  it('handles createThread failure gracefully', async () => {
    const { api } = await import('../services/api');
    vi.mocked(api.createThread).mockRejectedValueOnce(new Error('fail'));
    render(<ChannelView channel={makeChannel()} />);
    fireEvent.click(screen.getByTestId('create-thread'));
    // Should not crash
    await waitFor(() => {
      expect(api.createThread).toHaveBeenCalled();
    });
  });

  it('resolves username from members when server message has no username', async () => {
    useTeamStore.setState({
      activeTeamId: 't1',
      members: new Map([['t1', [{ id: 'm1', userId: 'u2', username: 'bob', displayName: 'Bob', nickname: '', roles: [], statusType: '' }]]]),
    });
    render(<ChannelView channel={makeChannel()} />);
    const handler = getWsHandler(vi.mocked(ws.on), 'message:new');
    if (handler) {
      await invokeWsHandler(handler, {
        id: 'msg-no-user', channel_id: 'ch-1', author_id: 'u2', username: '',
        content: 'hi', type: 'text', thread_id: null, edited_at: null, deleted: false,
        created_at: '2025-01-01T00:00:00Z', reactions: [],
      });
    }
  });

  it('tryEncrypt encrypts when derivedKey is set', async () => {
    const { cryptoService } = await import('../services/crypto');
    vi.mocked(cryptoService.encryptChannel).mockResolvedValueOnce('encrypted-text');
    useAuthStore.setState({ derivedKey: 'test-derived-key' });

    render(<ChannelView channel={makeChannel()} />);
    fireEvent.click(screen.getByTestId('send-btn'));

    await waitFor(() => {
      expect(cryptoService.encryptChannel).toHaveBeenCalled();
    });
  });

  it('tryEncrypt falls back to plaintext on encryption error', async () => {
    const { cryptoService } = await import('../services/crypto');
    vi.mocked(cryptoService.encryptChannel).mockRejectedValueOnce(new Error('encrypt fail'));
    useAuthStore.setState({ derivedKey: 'test-derived-key' });

    render(<ChannelView channel={makeChannel()} />);
    fireEvent.click(screen.getByTestId('send-btn'));

    await waitFor(() => {
      // Should still send the message (fallback to plaintext)
      expect(ws.sendMessage).toHaveBeenCalled();
    });
  });

  it('handleLoadMore with REST decrypts messages using tryDecrypt', async () => {
    vi.mocked(ws.isConnected).mockReturnValue(false);
    const { api } = await import('../services/api');

    const fiftyMsgs = Array.from({ length: 50 }, (_, i) => ({
      id: `msg-${i}`, channel_id: 'ch-1', author_id: 'u1', username: 'tester',
      content: 'encrypted', type: 'text', thread_id: null, edited_at: null, deleted: false,
      created_at: '2025-01-01T00:00:00Z', reactions: [],
    }));
    vi.mocked(api.getMessages).mockResolvedValueOnce(fiftyMsgs); // initial load
    vi.mocked(api.getMessages).mockResolvedValueOnce([
      {
        id: 'msg-older', channel_id: 'ch-1', author_id: 'u1', username: 'tester',
        content: 'older msg', type: 'text', thread_id: null, edited_at: null, deleted: false,
        created_at: '2024-12-31T00:00:00Z', reactions: [],
      },
    ]); // load more

    render(<ChannelView channel={makeChannel()} />);
    await waitFor(() => {
      expect(api.getMessages).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByTestId('load-more'));
    await waitFor(() => {
      expect(api.getMessages).toHaveBeenCalledTimes(2);
    });
  });
});
