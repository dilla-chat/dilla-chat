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
  default: ({ onSend, placeholder }: { onSend: (s: string) => void; placeholder: string }) => (
    <div data-testid="message-input">
      <input placeholder={placeholder} onKeyDown={(e) => {
        if (e.key === 'Enter') onSend((e.target as HTMLInputElement).value);
      }} />
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
});
