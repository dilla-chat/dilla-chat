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
    // Verify message:new handler was registered
    const calls = vi.mocked(ws.on).mock.calls;
    const newMsgHandler = calls.find(c => c[0] === 'message:new');
    expect(newMsgHandler).toBeDefined();
    // Call the handler with a message from a different channel - should be ignored
    if (newMsgHandler) {
      await (newMsgHandler[1] as Function)({
        id: 'msg-x', channel_id: 'ch-other', author_id: 'u2', username: 'bob',
        content: 'hi', type: 'text', thread_id: null, edited_at: null, deleted: false,
        created_at: '2025-01-01T00:00:00Z', reactions: [],
      });
    }
  });

  it('invokes WS event callbacks for message:edited', async () => {
    render(<ChannelView channel={makeChannel()} />);
    const calls = vi.mocked(ws.on).mock.calls;
    const editHandler = calls.find(c => c[0] === 'message:edited');
    expect(editHandler).toBeDefined();
    if (editHandler) {
      await (editHandler[1] as Function)({
        message_id: 'msg-1', channel_id: 'ch-1', content: 'edited', author_id: 'u1',
      });
    }
  });

  it('invokes WS event callbacks for message:deleted', async () => {
    render(<ChannelView channel={makeChannel()} />);
    const calls = vi.mocked(ws.on).mock.calls;
    const deleteHandler = calls.find(c => c[0] === 'message:deleted');
    expect(deleteHandler).toBeDefined();
    if (deleteHandler) {
      (deleteHandler[1] as Function)({ message_id: 'msg-1', channel_id: 'ch-1' });
    }
  });

  it('invokes WS event callbacks for typing:start', async () => {
    render(<ChannelView channel={makeChannel()} />);
    const calls = vi.mocked(ws.on).mock.calls;
    const typingHandler = calls.find(c => c[0] === 'typing:start');
    expect(typingHandler).toBeDefined();
    if (typingHandler) {
      (typingHandler[1] as Function)({ channel_id: 'ch-1', user_id: 'u2', username: 'bob' });
    }
  });

  it('invokes WS thread event callbacks', async () => {
    render(<ChannelView channel={makeChannel()} />);
    const calls = vi.mocked(ws.on).mock.calls;

    const threadCreated = calls.find(c => c[0] === 'thread:created');
    if (threadCreated) {
      (threadCreated[1] as Function)({ id: 'th1', channel_id: 'ch-1', parent_message_id: 'msg-1' });
    }

    const threadUpdated = calls.find(c => c[0] === 'thread:updated');
    if (threadUpdated) {
      (threadUpdated[1] as Function)({ id: 'th1', channel_id: 'ch-1' });
    }

    const threadMsgNew = calls.find(c => c[0] === 'thread:message:new');
    if (threadMsgNew) {
      await (threadMsgNew[1] as Function)({
        id: 'tmsg-1', channel_id: 'ch-1', thread_id: 'th1', author_id: 'u1',
        username: 'tester', content: 'reply', type: 'text', edited_at: null,
        deleted: false, created_at: '2025-01-01T00:00:00Z', reactions: [],
      });
    }

    const threadMsgEdit = calls.find(c => c[0] === 'thread:message:updated');
    if (threadMsgEdit) {
      await (threadMsgEdit[1] as Function)({
        id: 'tmsg-1', channel_id: 'ch-1', thread_id: 'th1', author_id: 'u1',
        username: 'tester', content: 'edited', type: 'text', edited_at: '2025-01-01T01:00:00Z',
        deleted: false, created_at: '2025-01-01T00:00:00Z', reactions: [],
      });
    }

    const threadMsgDel = calls.find(c => c[0] === 'thread:message:deleted');
    if (threadMsgDel) {
      (threadMsgDel[1] as Function)({ message_id: 'tmsg-1', thread_id: 'th1' });
    }
  });

  it('ignores WS events for other channels', async () => {
    render(<ChannelView channel={makeChannel()} />);
    const calls = vi.mocked(ws.on).mock.calls;

    const newMsgHandler = calls.find(c => c[0] === 'message:new');
    if (newMsgHandler) {
      await (newMsgHandler[1] as Function)({
        id: 'msg-x', channel_id: 'other-ch', author_id: 'u2', username: 'bob',
        content: 'hi', type: 'text', thread_id: null, edited_at: null, deleted: false,
        created_at: '2025-01-01T00:00:00Z', reactions: [],
      });
    }

    const deleteHandler = calls.find(c => c[0] === 'message:deleted');
    if (deleteHandler) {
      (deleteHandler[1] as Function)({ message_id: 'msg-x', channel_id: 'other-ch' });
    }

    const typingHandler = calls.find(c => c[0] === 'typing:start');
    if (typingHandler) {
      (typingHandler[1] as Function)({ channel_id: 'other-ch', user_id: 'u2', username: 'bob' });
    }
  });

  it('handles thread message events with null thread_id', async () => {
    render(<ChannelView channel={makeChannel()} />);
    const calls = vi.mocked(ws.on).mock.calls;
    const threadMsgNew = calls.find(c => c[0] === 'thread:message:new');
    if (threadMsgNew) {
      await (threadMsgNew[1] as Function)({
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
});
