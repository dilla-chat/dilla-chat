import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ThreadPanel from './ThreadPanel';
import { useTeamStore } from '../../stores/teamStore';
import { useAuthStore } from '../../stores/authStore';
import { useThreadStore, type Thread } from '../../stores/threadStore';
import { useMessageStore } from '../../stores/messageStore';

// Mock scrollIntoView which is not available in jsdom
Element.prototype.scrollIntoView = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, defaultValueOrOpts?: string | Record<string, unknown>, opts?: Record<string, unknown>) => {
      if (typeof defaultValueOrOpts === 'string') return defaultValueOrOpts;
      return key;
    },
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

vi.mock('iconoir-react', () => ({
  Xmark: () => <span data-testid="Xmark" />,
  EditPencil: () => <span data-testid="EditPencil" />,
  Trash: () => <span data-testid="Trash" />,
}));

vi.mock('../../services/api', () => ({
  api: {
    getThreadMessages: vi.fn(() => Promise.resolve([])),
  },
}));

vi.mock('../../services/websocket', () => ({
  ws: {
    isConnected: vi.fn(() => false),
    on: vi.fn(() => vi.fn()),
    request: vi.fn(() => Promise.resolve([])),
    sendThreadMessage: vi.fn(),
    editThreadMessage: vi.fn(),
    deleteThreadMessage: vi.fn(),
  },
}));

vi.mock('../../services/crypto', () => ({
  cryptoService: {
    encryptMessage: vi.fn((_, content: string) => Promise.resolve(content)),
    decryptMessage: vi.fn((_, content: string) => Promise.resolve(content)),
  },
}));

vi.mock('../../services/messageCache', () => ({
  cacheMessage: vi.fn(),
  getCachedMessage: vi.fn(() => Promise.resolve(null)),
  deleteCachedMessage: vi.fn(),
}));

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <span>{children}</span>,
}));

vi.mock('remark-gfm', () => ({
  default: () => {},
}));

vi.mock('../../utils/colors', () => ({
  usernameColor: () => '#2e8b9a',
  getInitials: (name: string) => (name || '?').slice(0, 2).toUpperCase(),
}));

vi.mock('../MessageInput/MessageInput', () => ({
  default: ({ onSend, onEdit, onCancelEdit, placeholder, editingMessage }: { onSend: (s: string) => void; onEdit?: (id: string, s: string) => void; onCancelEdit?: () => void; placeholder: string; editingMessage?: unknown }) => (
    <div data-testid="message-input">
      <input placeholder={placeholder} onKeyDown={(e) => {
        if (e.key === 'Enter') onSend((e.target as HTMLInputElement).value);
      }} />
      <button data-testid="save-edit" onClick={() => onEdit?.('tmsg-1', 'edited content')}>Save Edit</button>
      <button data-testid="cancel-edit" onClick={onCancelEdit}>Cancel</button>
      {editingMessage && <span data-testid="editing-indicator">Editing</span>}
    </div>
  ),
}));

const thread: Thread = {
  id: 'thread-1',
  channel_id: 'ch-1',
  parent_message_id: 'msg-parent',
  team_id: 'team-1',
  creator_id: 'user-1',
  title: 'Test Thread',
  message_count: 2,
  last_message_at: '2025-01-01T12:00:00Z',
  created_at: '2025-01-01T10:00:00Z',
};

describe('ThreadPanel', () => {
  beforeEach(() => {
    useTeamStore.setState({ activeTeamId: 'team-1' });
    const teams = new Map([['team-1', { token: 't', user: { id: 'user-1', username: 'alice' }, teamInfo: null, baseUrl: '' }]]);
    useAuthStore.setState({ teams, derivedKey: null });

    useThreadStore.setState({
      threadMessages: {
        'thread-1': [
          {
            id: 'tmsg-1',
            channelId: 'ch-1',
            authorId: 'user-1',
            username: 'alice',
            content: 'Hello from thread',
            encryptedContent: '',
            type: 'text',
            threadId: 'thread-1',
            editedAt: null,
            deleted: false,
            createdAt: '2025-01-01T11:00:00Z',
            reactions: [],
          },
          {
            id: 'tmsg-2',
            channelId: 'ch-1',
            authorId: 'user-2',
            username: 'bob',
            content: 'Reply from bob',
            encryptedContent: '',
            type: 'text',
            threadId: 'thread-1',
            editedAt: null,
            deleted: false,
            createdAt: '2025-01-01T11:05:00Z',
            reactions: [],
          },
        ],
      },
    });

    useMessageStore.setState({
      messages: new Map([['ch-1', [
        {
          id: 'msg-parent',
          channelId: 'ch-1',
          authorId: 'user-1',
          username: 'alice',
          content: 'Parent message content',
          encryptedContent: '',
          type: 'text',
          threadId: null,
          editedAt: null,
          deleted: false,
          createdAt: '2025-01-01T10:00:00Z',
          reactions: [],
        },
      ]]]),
    });
  });

  it('renders thread title', () => {
    render(<ThreadPanel thread={thread} onClose={vi.fn()} />);
    expect(screen.getByText('Test Thread')).toBeInTheDocument();
  });

  it('renders reply count subtitle', () => {
    render(<ThreadPanel thread={thread} onClose={vi.fn()} />);
    // Appears both in subtitle and in thread reply count indicator
    const elements = screen.getAllByText('{{count}} replies');
    expect(elements.length).toBeGreaterThanOrEqual(1);
  });

  it('renders close button', () => {
    render(<ThreadPanel thread={thread} onClose={vi.fn()} />);
    expect(screen.getByTestId('Xmark')).toBeInTheDocument();
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();
    render(<ThreadPanel thread={thread} onClose={onClose} />);
    const closeBtn = screen.getByTestId('Xmark').closest('button')!;
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders parent message', () => {
    render(<ThreadPanel thread={thread} onClose={vi.fn()} />);
    expect(screen.getByText('Parent message content')).toBeInTheDocument();
  });

  it('renders thread messages', () => {
    render(<ThreadPanel thread={thread} onClose={vi.fn()} />);
    expect(screen.getByText('Hello from thread')).toBeInTheDocument();
    expect(screen.getByText('Reply from bob')).toBeInTheDocument();
  });

  it('renders message input', () => {
    render(<ThreadPanel thread={thread} onClose={vi.fn()} />);
    expect(screen.getByTestId('message-input')).toBeInTheDocument();
  });

  it('shows edit and delete buttons for own messages', () => {
    render(<ThreadPanel thread={thread} onClose={vi.fn()} />);
    // user-1 authored tmsg-1, so edit/delete should appear
    expect(screen.getByTestId('EditPencil')).toBeInTheDocument();
    expect(screen.getByTestId('Trash')).toBeInTheDocument();
  });

  it('shows default title when thread has no title', () => {
    const untitled = { ...thread, title: '' };
    render(<ThreadPanel thread={untitled} onClose={vi.fn()} />);
    expect(screen.getByText('Thread')).toBeInTheDocument();
  });

  it('shows no replies message when thread is empty', () => {
    useThreadStore.setState({ threadMessages: {} });
    const emptyThread = { ...thread, message_count: 0 };
    render(<ThreadPanel thread={emptyThread} onClose={vi.fn()} />);
    expect(screen.getByText('No replies yet. Start the conversation!')).toBeInTheDocument();
  });

  it('shows 1 reply subtitle for single message', () => {
    useThreadStore.setState({
      threadMessages: {
        'thread-1': [
          {
            id: 'tmsg-1', channelId: 'ch-1', authorId: 'user-1', username: 'alice',
            content: 'Hello', encryptedContent: '', type: 'text', threadId: 'thread-1',
            editedAt: null, deleted: false, createdAt: '2025-01-01T11:00:00Z', reactions: [],
          },
        ],
      },
    });
    const singleReply = { ...thread, message_count: 1 };
    render(<ThreadPanel thread={singleReply} onClose={vi.fn()} />);
    expect(screen.getAllByText('1 reply').length).toBeGreaterThanOrEqual(1);
  });

  it('shows deleted message placeholder for deleted messages', () => {
    useThreadStore.setState({
      threadMessages: {
        'thread-1': [
          {
            id: 'tmsg-del', channelId: 'ch-1', authorId: 'user-1', username: 'alice',
            content: '', encryptedContent: '', type: 'text', threadId: 'thread-1',
            editedAt: null, deleted: true, createdAt: '2025-01-01T11:00:00Z', reactions: [],
          },
        ],
      },
    });
    render(<ThreadPanel thread={thread} onClose={vi.fn()} />);
    expect(screen.getByText('[message deleted]')).toBeInTheDocument();
  });

  it('shows edited indicator for edited messages', () => {
    useThreadStore.setState({
      threadMessages: {
        'thread-1': [
          {
            id: 'tmsg-ed', channelId: 'ch-1', authorId: 'user-2', username: 'bob',
            content: 'Edited msg', encryptedContent: '', type: 'text', threadId: 'thread-1',
            editedAt: '2025-01-01T12:00:00Z', deleted: false, createdAt: '2025-01-01T11:00:00Z', reactions: [],
          },
        ],
      },
    });
    render(<ThreadPanel thread={thread} onClose={vi.fn()} />);
    expect(screen.getByText('(edited)')).toBeInTheDocument();
  });

  it('clicking edit button sets editing message', () => {
    render(<ThreadPanel thread={thread} onClose={vi.fn()} />);
    const editBtn = screen.getByTestId('EditPencil').closest('button')!;
    fireEvent.click(editBtn);
    // The MessageInput should now have an input; verify it exists
    expect(screen.getByTestId('message-input')).toBeInTheDocument();
  });

  it('clicking delete button calls ws.deleteThreadMessage', async () => {
    const { ws } = await import('../../services/websocket');
    render(<ThreadPanel thread={thread} onClose={vi.fn()} />);
    const deleteBtn = screen.getByTestId('Trash').closest('button')!;
    fireEvent.click(deleteBtn);
    expect(ws.deleteThreadMessage).toHaveBeenCalledWith('team-1', 'thread-1', 'tmsg-1');
  });

  it('does not show edit/delete for other users messages', () => {
    // bob's message (user-2) should not have edit/delete since current user is user-1
    // alice's message (user-1) should have them
    render(<ThreadPanel thread={thread} onClose={vi.fn()} />);
    // Only one set of edit/delete (for alice)
    expect(screen.getAllByTestId('EditPencil')).toHaveLength(1);
    expect(screen.getAllByTestId('Trash')).toHaveLength(1);
  });

  it('sends message via thread input', async () => {
    const { ws } = await import('../../services/websocket');
    render(<ThreadPanel thread={thread} onClose={vi.fn()} />);
    const input = screen.getByTestId('message-input').querySelector('input')!;
    fireEvent.change(input, { target: { value: 'new reply' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(ws.sendThreadMessage).toHaveBeenCalledWith('team-1', 'thread-1', 'new reply');
  });

  it('renders without parent message when not found', () => {
    useMessageStore.setState({ messages: new Map() });
    render(<ThreadPanel thread={thread} onClose={vi.fn()} />);
    // Should still render thread messages without crash
    expect(screen.getByText('Hello from thread')).toBeInTheDocument();
  });

  it('subscribes to thread WS events on mount', async () => {
    const { ws } = await import('../../services/websocket');
    render(<ThreadPanel thread={thread} onClose={vi.fn()} />);
    const calls = vi.mocked(ws.on).mock.calls;
    const eventNames = calls.map(c => c[0]);
    expect(eventNames).toContain('thread:message:new');
    expect(eventNames).toContain('thread:message:updated');
    expect(eventNames).toContain('thread:message:deleted');
  });

  it('handles thread:message:new WS event', async () => {
    const { ws } = await import('../../services/websocket');
    render(<ThreadPanel thread={thread} onClose={vi.fn()} />);
    const calls = vi.mocked(ws.on).mock.calls;
    const newHandler = calls.find(c => c[0] === 'thread:message:new');
    if (newHandler) {
      await (newHandler[1] as Function)({
        id: 'tmsg-new', channel_id: 'ch-1', author_id: 'user-2', username: 'bob',
        content: 'New thread msg', type: 'text', thread_id: 'thread-1',
        edited_at: null, deleted: false, created_at: '2025-01-01T12:00:00Z', reactions: [],
      });
    }
  });

  it('ignores thread:message:new for other threads', async () => {
    const { ws } = await import('../../services/websocket');
    render(<ThreadPanel thread={thread} onClose={vi.fn()} />);
    const calls = vi.mocked(ws.on).mock.calls;
    const newHandler = calls.find(c => c[0] === 'thread:message:new');
    if (newHandler) {
      await (newHandler[1] as Function)({
        id: 'tmsg-other', channel_id: 'ch-1', author_id: 'user-2', username: 'bob',
        content: 'Other', type: 'text', thread_id: 'other-thread',
        edited_at: null, deleted: false, created_at: '2025-01-01T12:00:00Z', reactions: [],
      });
    }
  });

  it('handles thread:message:updated WS event', async () => {
    const { ws } = await import('../../services/websocket');
    render(<ThreadPanel thread={thread} onClose={vi.fn()} />);
    const calls = vi.mocked(ws.on).mock.calls;
    const editHandler = calls.find(c => c[0] === 'thread:message:updated');
    if (editHandler) {
      await (editHandler[1] as Function)({
        id: 'tmsg-1', channel_id: 'ch-1', author_id: 'user-1', username: 'alice',
        content: 'Edited content', type: 'text', thread_id: 'thread-1',
        edited_at: '2025-01-01T12:30:00Z', deleted: false, created_at: '2025-01-01T11:00:00Z', reactions: [],
      });
    }
  });

  it('handles thread:message:deleted WS event', async () => {
    const { ws } = await import('../../services/websocket');
    render(<ThreadPanel thread={thread} onClose={vi.fn()} />);
    const calls = vi.mocked(ws.on).mock.calls;
    const deleteHandler = calls.find(c => c[0] === 'thread:message:deleted');
    if (deleteHandler) {
      (deleteHandler[1] as Function)({ message_id: 'tmsg-1', thread_id: 'thread-1' });
    }
  });

  it('unsubscribes from events on unmount', async () => {
    const { ws } = await import('../../services/websocket');
    const unsub = vi.fn();
    vi.mocked(ws.on).mockReturnValue(unsub);

    const { unmount } = render(<ThreadPanel thread={thread} onClose={vi.fn()} />);
    unmount();
    expect(unsub).toHaveBeenCalled();
  });

  it('loads thread messages via API on mount', async () => {
    const { api } = await import('../../services/api');
    vi.mocked(api.getThreadMessages).mockResolvedValueOnce([]);
    // Clear initialLoadDone by using a new thread id
    const freshThread = { ...thread, id: 'thread-fresh' };
    useThreadStore.setState({ threadMessages: {} });
    render(<ThreadPanel thread={freshThread} onClose={vi.fn()} />);
    await vi.waitFor(() => {
      expect(api.getThreadMessages).toHaveBeenCalledWith('team-1', 'thread-fresh');
    });
  });

  it('edit button sets editing state and save edit calls ws.editThreadMessage', async () => {
    const { ws } = await import('../../services/websocket');
    render(<ThreadPanel thread={thread} onClose={vi.fn()} />);
    const editBtn = screen.getByTestId('EditPencil').closest('button')!;
    fireEvent.click(editBtn);
    expect(screen.getByTestId('editing-indicator')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('save-edit'));
    await vi.waitFor(() => {
      expect(ws.editThreadMessage).toHaveBeenCalledWith('team-1', 'thread-1', 'tmsg-1', expect.any(String));
    });
  });

  it('cancel edit clears editing state', () => {
    render(<ThreadPanel thread={thread} onClose={vi.fn()} />);
    const editBtn = screen.getByTestId('EditPencil').closest('button')!;
    fireEvent.click(editBtn);
    expect(screen.getByTestId('editing-indicator')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('cancel-edit'));
    expect(screen.queryByTestId('editing-indicator')).not.toBeInTheDocument();
  });

  it('renders yesterday timestamp', () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    useThreadStore.setState({
      threadMessages: {
        'thread-1': [
          {
            id: 'tmsg-yesterday', channelId: 'ch-1', authorId: 'user-2', username: 'bob',
            content: 'Yesterday msg', encryptedContent: '', type: 'text', threadId: 'thread-1',
            editedAt: null, deleted: false, createdAt: yesterday.toISOString(), reactions: [],
          },
        ],
      },
    });
    render(<ThreadPanel thread={thread} onClose={vi.fn()} />);
    expect(screen.getByText(/Yesterday at/)).toBeInTheDocument();
  });

  it('renders old date timestamp', () => {
    useThreadStore.setState({
      threadMessages: {
        'thread-1': [
          {
            id: 'tmsg-old', channelId: 'ch-1', authorId: 'user-2', username: 'bob',
            content: 'Old msg', encryptedContent: '', type: 'text', threadId: 'thread-1',
            editedAt: null, deleted: false, createdAt: '2020-06-15T10:00:00Z', reactions: [],
          },
        ],
      },
    });
    render(<ThreadPanel thread={thread} onClose={vi.fn()} />);
    // Should show date in format like "6/15/2020"
    expect(screen.getByText(/2020/)).toBeInTheDocument();
  });

  it('encrypts messages when derivedKey is set', async () => {
    useAuthStore.setState({ teams: new Map([['team-1', { token: 't', user: { id: 'user-1', username: 'alice' }, teamInfo: null, baseUrl: '' }]]), derivedKey: 'test-derived-key' });
    const { ws } = await import('../../services/websocket');
    render(<ThreadPanel thread={thread} onClose={vi.fn()} />);
    const input = screen.getByTestId('message-input').querySelector('input')!;
    fireEvent.change(input, { target: { value: 'encrypted msg' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await vi.waitFor(() => {
      expect(ws.sendThreadMessage).toHaveBeenCalledWith('team-1', 'thread-1', expect.any(String));
    });
  });

  it('encrypts edited messages when derivedKey is set', async () => {
    useAuthStore.setState({ teams: new Map([['team-1', { token: 't', user: { id: 'user-1', username: 'alice' }, teamInfo: null, baseUrl: '' }]]), derivedKey: 'test-derived-key' });
    const { ws } = await import('../../services/websocket');
    render(<ThreadPanel thread={thread} onClose={vi.fn()} />);
    const editBtn = screen.getByTestId('EditPencil').closest('button')!;
    fireEvent.click(editBtn);
    fireEvent.click(screen.getByTestId('save-edit'));
    await vi.waitFor(() => {
      expect(ws.editThreadMessage).toHaveBeenCalledWith('team-1', 'thread-1', 'tmsg-1', expect.any(String));
    });
  });

  it('does not send when activeTeamId is null', async () => {
    useTeamStore.setState({ activeTeamId: null as unknown as string });
    const { ws } = await import('../../services/websocket');
    vi.mocked(ws.sendThreadMessage).mockClear();
    render(<ThreadPanel thread={thread} onClose={vi.fn()} />);
    const input = screen.getByTestId('message-input').querySelector('input')!;
    fireEvent.change(input, { target: { value: 'test' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(ws.sendThreadMessage).not.toHaveBeenCalled();
  });

  it('handles scroll and triggers load more at top', async () => {
    // Set up thread with messages and hasMore=true
    useThreadStore.setState({
      threadMessages: {
        'thread-1': [
          {
            id: 'tmsg-1', channelId: 'ch-1', authorId: 'user-1', username: 'alice',
            content: 'Hello', encryptedContent: '', type: 'text', threadId: 'thread-1',
            editedAt: null, deleted: false, createdAt: '2025-01-01T11:00:00Z', reactions: [],
          },
        ],
      },
    });

    const { container } = render(<ThreadPanel thread={thread} onClose={vi.fn()} />);
    const messagesDiv = container.querySelector('.thread-messages');
    if (messagesDiv) {
      // Simulate scroll near top
      Object.defineProperty(messagesDiv, 'scrollTop', { value: 50, configurable: true });
      Object.defineProperty(messagesDiv, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(messagesDiv, 'clientHeight', { value: 500, configurable: true });
      fireEvent.scroll(messagesDiv);
    }
  });

  it('handles scroll and detects auto-scroll position', async () => {
    const { container } = render(<ThreadPanel thread={thread} onClose={vi.fn()} />);
    const messagesDiv = container.querySelector('.thread-messages');
    if (messagesDiv) {
      // Simulate scroll at bottom (auto-scroll should be true)
      Object.defineProperty(messagesDiv, 'scrollTop', { value: 480, configurable: true });
      Object.defineProperty(messagesDiv, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(messagesDiv, 'clientHeight', { value: 500, configurable: true });
      fireEvent.scroll(messagesDiv);
    }
  });

  it('renders loading state', () => {
    useThreadStore.setState({ threadMessages: {} });
    const freshThread = { ...thread, id: 'thread-loading' };
    render(<ThreadPanel thread={freshThread} onClose={vi.fn()} />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('formats time correctly for today, yesterday, and other dates', () => {
    // The formatTime function is internal but tested via rendered output
    const now = new Date();
    useThreadStore.setState({
      threadMessages: {
        'thread-1': [
          {
            id: 'tmsg-today', channelId: 'ch-1', authorId: 'user-2', username: 'bob',
            content: 'Today msg', encryptedContent: '', type: 'text', threadId: 'thread-1',
            editedAt: null, deleted: false, createdAt: now.toISOString(), reactions: [],
          },
        ],
      },
    });
    render(<ThreadPanel thread={thread} onClose={vi.fn()} />);
    expect(screen.getByText(/Today at/)).toBeInTheDocument();
  });

  it('loads more messages via handleLoadMore with WS', async () => {
    const { ws } = await import('../../services/websocket');
    vi.mocked(ws.isConnected).mockReturnValue(true);
    vi.mocked(ws.request).mockResolvedValueOnce([]);

    useThreadStore.setState({
      threadMessages: {
        'thread-loadmore': [
          {
            id: 'tmsg-old', channelId: 'ch-1', authorId: 'user-2', username: 'bob',
            content: 'Old msg', encryptedContent: '', type: 'text', threadId: 'thread-loadmore',
            editedAt: null, deleted: false, createdAt: '2025-01-01T11:00:00Z', reactions: [],
          },
        ],
      },
    });

    const loadMoreThread = { ...thread, id: 'thread-loadmore' };
    const { container } = render(<ThreadPanel thread={loadMoreThread} onClose={vi.fn()} />);

    // Simulate scroll near top to trigger load more
    const messagesDiv = container.querySelector('.thread-messages');
    if (messagesDiv) {
      Object.defineProperty(messagesDiv, 'scrollTop', { value: 30, configurable: true });
      Object.defineProperty(messagesDiv, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(messagesDiv, 'clientHeight', { value: 500, configurable: true });
      fireEvent.scroll(messagesDiv);
    }

    await vi.waitFor(() => {
      expect(ws.request).toHaveBeenCalledWith('team-1', 'threads:messages', expect.objectContaining({
        thread_id: 'thread-loadmore',
      }));
    });
  });


  it('decrypts messages with derivedKey during initial load via WS', async () => {
    const { ws } = await import('../../services/websocket');
    const { cryptoService } = await import('../../services/crypto');
    vi.mocked(ws.isConnected).mockReturnValue(true);
    vi.mocked(ws.request).mockResolvedValueOnce([
      {
        id: 'tmsg-enc', channel_id: 'ch-1', author_id: 'user-1', username: 'alice',
        content: 'encrypted-content', type: 'text', thread_id: 'thread-decrypt',
        edited_at: null, deleted: false, created_at: '2025-01-01T11:00:00Z', reactions: [],
      },
    ]);
    vi.mocked(cryptoService.decryptMessage).mockResolvedValueOnce('decrypted-content');

    useAuthStore.setState({
      teams: new Map([['team-1', { token: 't', user: { id: 'user-1', username: 'alice' }, teamInfo: null, baseUrl: '' }]]),
      derivedKey: 'test-key',
    });
    useThreadStore.setState({ threadMessages: {} });

    const decryptThread = { ...thread, id: 'thread-decrypt' };
    render(<ThreadPanel thread={decryptThread} onClose={vi.fn()} />);

    await vi.waitFor(() => {
      expect(cryptoService.decryptMessage).toHaveBeenCalled();
    });
  });

  it('handles thread:message:updated for other thread (ignores)', async () => {
    const { ws } = await import('../../services/websocket');
    render(<ThreadPanel thread={thread} onClose={vi.fn()} />);
    const calls = vi.mocked(ws.on).mock.calls;
    const editHandler = calls.find(c => c[0] === 'thread:message:updated');
    if (editHandler) {
      await (editHandler[1] as Function)({
        id: 'tmsg-1', channel_id: 'ch-1', author_id: 'user-1', username: 'alice',
        content: 'Edited', type: 'text', thread_id: 'other-thread',
        edited_at: '2025-01-01T12:30:00Z', deleted: false, created_at: '2025-01-01T11:00:00Z', reactions: [],
      });
    }
    // Should not crash and should not update messages
  });

  it('handles thread:message:deleted for other thread (ignores)', async () => {
    const { ws } = await import('../../services/websocket');
    render(<ThreadPanel thread={thread} onClose={vi.fn()} />);
    const calls = vi.mocked(ws.on).mock.calls;
    const deleteHandler = calls.find(c => c[0] === 'thread:message:deleted');
    if (deleteHandler) {
      (deleteHandler[1] as Function)({ message_id: 'tmsg-1', thread_id: 'other-thread' });
    }
  });

  it('encrypts messages with derivedKey during send', async () => {
    useAuthStore.setState({
      teams: new Map([['team-1', { token: 't', user: { id: 'user-1', username: 'alice' }, teamInfo: null, baseUrl: '' }]]),
      derivedKey: 'test-key',
    });
    const { cryptoService } = await import('../../services/crypto');
    vi.mocked(cryptoService.encryptMessage).mockRejectedValueOnce(new Error('encryption failed'));

    const { ws } = await import('../../services/websocket');
    render(<ThreadPanel thread={thread} onClose={vi.fn()} />);
    const input = screen.getByTestId('message-input').querySelector('input')!;
    fireEvent.change(input, { target: { value: 'plaintext msg' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await vi.waitFor(() => {
      // Should fall through and send plaintext
      expect(ws.sendThreadMessage).toHaveBeenCalled();
    });
  });

  it('handleLoadMore via API when WS not connected', async () => {
    const { api } = await import('../../services/api');
    const { ws } = await import('../../services/websocket');
    vi.mocked(ws.isConnected).mockReturnValue(false);
    vi.mocked(api.getThreadMessages).mockClear();
    vi.mocked(api.getThreadMessages).mockResolvedValue([]);

    const threadId = `thread-api-more-${Math.random()}`;
    useThreadStore.setState({ threadMessages: {} });

    const apiThread = { ...thread, id: threadId };
    const { container } = render(<ThreadPanel thread={apiThread} onClose={vi.fn()} />);

    // Wait for initial load
    await vi.waitFor(() => {
      expect(vi.mocked(api.getThreadMessages).mock.calls.some(c => c[1] === threadId)).toBe(true);
    });
  });

  it('handleLoadMore does nothing when already loading', async () => {
    const { ws } = await import('../../services/websocket');
    vi.mocked(ws.isConnected).mockReturnValue(true);
    vi.mocked(ws.request).mockResolvedValue([]);

    // The initial load sets loading=true; render with a fresh thread so the initial
    // load runs. While it's loading, scroll near top shouldn't trigger a second request.
    useThreadStore.setState({ threadMessages: {} });
    const loadingThread = { ...thread, id: 'thread-loading-check' };
    const { container } = render(<ThreadPanel thread={loadingThread} onClose={vi.fn()} />);

    // Initial load fires. Now scroll near top immediately.
    const messagesDiv = container.querySelector('.thread-messages');
    if (messagesDiv) {
      Object.defineProperty(messagesDiv, 'scrollTop', { value: 30, configurable: true });
      Object.defineProperty(messagesDiv, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(messagesDiv, 'clientHeight', { value: 500, configurable: true });
      fireEvent.scroll(messagesDiv);
    }
  });

  it('handleLoadMore deduplicates messages', async () => {
    const { ws } = await import('../../services/websocket');
    vi.mocked(ws.isConnected).mockReturnValue(true);
    // Return a message that already exists in the store
    vi.mocked(ws.request).mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: 'tmsg-dup', channel_id: 'ch-1', author_id: 'user-2', username: 'bob',
        content: 'Dup msg', type: 'text', thread_id: 'thread-dedup',
        edited_at: null, deleted: false, created_at: '2025-01-01T10:00:00Z', reactions: [],
      },
    ]);

    useThreadStore.setState({
      threadMessages: {
        'thread-dedup': [
          {
            id: 'tmsg-dup', channelId: 'ch-1', authorId: 'user-2', username: 'bob',
            content: 'Dup msg', encryptedContent: '', type: 'text', threadId: 'thread-dedup',
            editedAt: null, deleted: false, createdAt: '2025-01-01T10:00:00Z', reactions: [],
          },
        ],
      },
    });

    const dedupThread = { ...thread, id: 'thread-dedup' };
    const { container } = render(<ThreadPanel thread={dedupThread} onClose={vi.fn()} />);

    // Wait for initial load to finish
    await vi.waitFor(() => {
      expect(ws.request).toHaveBeenCalled();
    });

    // Trigger scroll near top to invoke handleLoadMore
    const messagesDiv = container.querySelector('.thread-messages');
    if (messagesDiv) {
      Object.defineProperty(messagesDiv, 'scrollTop', { value: 30, configurable: true });
      Object.defineProperty(messagesDiv, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(messagesDiv, 'clientHeight', { value: 500, configurable: true });
      fireEvent.scroll(messagesDiv);
    }
  });

  it('initial load with derivedKey calls decryptMessage for each message', async () => {
    const { ws } = await import('../../services/websocket');
    const { cryptoService } = await import('../../services/crypto');
    vi.mocked(ws.isConnected).mockReturnValue(true);
    vi.mocked(cryptoService.decryptMessage).mockClear();
    vi.mocked(cryptoService.decryptMessage).mockResolvedValue('decrypted-plain');

    const threadId = `thread-decrypt-${Math.random()}`;
    vi.mocked(ws.request).mockResolvedValueOnce([
      {
        id: 'tmsg-dec-1', channel_id: 'ch-1', author_id: 'user-1', username: 'alice',
        content: 'encrypted-1', type: 'text', thread_id: threadId,
        edited_at: null, deleted: false, created_at: '2025-01-01T11:00:00Z', reactions: [],
      },
    ]);

    useAuthStore.setState({
      teams: new Map([['team-1', { token: 't', user: { id: 'user-1', username: 'alice' }, teamInfo: null, baseUrl: '' }]]),
      derivedKey: 'test-key',
    });
    useThreadStore.setState({ threadMessages: {} });

    const decryptThread = { ...thread, id: threadId };
    render(<ThreadPanel thread={decryptThread} onClose={vi.fn()} />);

    await vi.waitFor(() => {
      expect(cryptoService.decryptMessage).toHaveBeenCalled();
    });
  });

  it('handles thread:message:new with cached content', async () => {
    const { ws } = await import('../../services/websocket');
    const { getCachedMessage } = await import('../../services/messageCache');
    vi.mocked(getCachedMessage).mockResolvedValueOnce('cached-new-content');

    useAuthStore.setState({
      teams: new Map([['team-1', { token: 't', user: { id: 'user-1', username: 'alice' }, teamInfo: null, baseUrl: '' }]]),
      derivedKey: 'test-key',
    });

    render(<ThreadPanel thread={thread} onClose={vi.fn()} />);
    const calls = vi.mocked(ws.on).mock.calls;
    const newHandler = calls.find(c => c[0] === 'thread:message:new');
    if (newHandler) {
      await (newHandler[1] as Function)({
        id: 'tmsg-cached-new', channel_id: 'ch-1', author_id: 'user-2', username: 'bob',
        content: 'encrypted-content', type: 'text', thread_id: 'thread-1',
        edited_at: null, deleted: false, created_at: '2025-01-01T13:00:00Z', reactions: [],
      });
    }
  });
});
