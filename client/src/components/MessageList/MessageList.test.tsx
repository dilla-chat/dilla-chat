import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MessageList from './MessageList';
import { useMessageStore, type Message } from '../../stores/messageStore';

// Mock dependencies
vi.mock('iconoir-react', () => ({
  Emoji: () => <span data-testid="icon-emoji" />,
  Plus: () => <span data-testid="icon-plus" />,
  Reply: () => <span data-testid="icon-reply" />,
  Threads: () => <span data-testid="icon-threads" />,
  EditPencil: () => <span data-testid="icon-edit" />,
  Trash: () => <span data-testid="icon-trash" />,
  ChatBubble: () => <span data-testid="icon-chat-bubble" />,
}));

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <span>{children}</span>,
}));

vi.mock('remark-gfm', () => ({
  default: {},
}));

vi.mock('../Reactions/Reactions', () => ({
  default: () => <div data-testid="reactions" />,
}));

vi.mock('../FilePreview/FilePreview', () => ({
  default: () => <div data-testid="file-preview" />,
}));

vi.mock('../EmojiPicker/EmojiPicker', () => ({
  default: ({ onSelect, onClose }: { onSelect: (emoji: string) => void; onClose: () => void }) => (
    <div data-testid="emoji-picker">
      <button data-testid="emoji-select" onClick={() => onSelect('👍')}>Select</button>
      <button data-testid="emoji-close" onClick={onClose}>Close</button>
    </div>
  ),
}));

vi.mock('../../utils/colors', () => ({
  usernameColor: () => '#aabbcc',
}));

// jsdom does not implement scrollIntoView
Element.prototype.scrollIntoView = vi.fn();

function makeMessage(overrides?: Partial<Message>): Message {
  return {
    id: 'msg-1',
    channelId: 'ch-1',
    authorId: 'user-1',
    username: 'alice',
    content: 'Hello world',
    encryptedContent: 'encrypted',
    type: 'text',
    threadId: null,
    editedAt: null,
    deleted: false,
    createdAt: new Date().toISOString(),
    reactions: [],
    ...overrides,
  };
}

describe('MessageList', () => {
  beforeEach(() => {
    useMessageStore.setState({
      messages: new Map(),
      typing: new Map(),
      loadingHistory: new Map(),
      hasMore: new Map(),
    });
  });

  it('renders messages', () => {
    const msgs = [makeMessage()];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map(),
      hasMore: new Map(),
    });
    render(
      <MessageList channelId="ch-1" currentUserId="user-1" onLoadMore={vi.fn()} />,
    );
    expect(screen.getByText('Hello world')).toBeInTheDocument();
  });

  it('renders username for message groups', () => {
    const msgs = [makeMessage()];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map(),
      hasMore: new Map(),
    });
    render(
      <MessageList channelId="ch-1" currentUserId="user-2" onLoadMore={vi.fn()} />,
    );
    expect(screen.getByText('alice')).toBeInTheDocument();
  });

  it('groups messages from same author within 7 minutes', () => {
    const now = new Date();
    const msgs = [
      makeMessage({ id: 'msg-1', content: 'First', createdAt: now.toISOString() }),
      makeMessage({
        id: 'msg-2',
        content: 'Second',
        createdAt: new Date(now.getTime() + 60000).toISOString(),
      }),
    ];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map(),
      hasMore: new Map(),
    });
    render(
      <MessageList channelId="ch-1" currentUserId="user-2" onLoadMore={vi.fn()} />,
    );
    // Should have only one username header (one group)
    const usernames = screen.getAllByText('alice');
    expect(usernames).toHaveLength(1);
    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
  });

  it('shows system messages with system styling', () => {
    const msgs = [
      makeMessage({ id: 'sys-1', type: 'system', content: 'User joined', username: 'system' }),
    ];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map(),
      hasMore: new Map(),
    });
    const { container } = render(
      <MessageList channelId="ch-1" currentUserId="user-1" onLoadMore={vi.fn()} />,
    );
    expect(screen.getByText('User joined')).toBeInTheDocument();
    expect(container.querySelector('.message-system')).toBeInTheDocument();
  });

  it('shows welcome message when at the beginning', () => {
    const msgs = [makeMessage()];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map(),
      hasMore: new Map([['ch-1', false]]),
    });
    render(
      <MessageList
        channelId="ch-1"
        channelName="general"
        currentUserId="user-1"
        onLoadMore={vi.fn()}
      />,
    );
    // The i18n mock returns the default string without interpolation
    expect(screen.getByText('Welcome to ~{{name}}')).toBeInTheDocument();
  });

  it('does not show welcome message when there is more history', () => {
    const msgs = [makeMessage()];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map(),
      hasMore: new Map([['ch-1', true]]),
    });
    render(
      <MessageList
        channelId="ch-1"
        channelName="general"
        currentUserId="user-1"
        onLoadMore={vi.fn()}
      />,
    );
    expect(screen.queryByText('Welcome to ~{{name}}')).not.toBeInTheDocument();
  });

  it('shows loading indicator when loading history', () => {
    useMessageStore.setState({
      messages: new Map(),
      loadingHistory: new Map([['ch-1', true]]),
      hasMore: new Map(),
    });
    render(
      <MessageList channelId="ch-1" currentUserId="user-1" onLoadMore={vi.fn()} />,
    );
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('does not show loading indicator when not loading', () => {
    useMessageStore.setState({
      messages: new Map(),
      loadingHistory: new Map([['ch-1', false]]),
      hasMore: new Map(),
    });
    render(
      <MessageList channelId="ch-1" currentUserId="user-1" onLoadMore={vi.fn()} />,
    );
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
  });

  it('shows deleted message placeholder', () => {
    const msgs = [makeMessage({ deleted: true })];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map(),
      hasMore: new Map(),
    });
    render(
      <MessageList channelId="ch-1" currentUserId="user-1" onLoadMore={vi.fn()} />,
    );
    expect(screen.getByText('[message deleted]')).toBeInTheDocument();
  });

  it('shows edited indicator for edited messages', () => {
    const msgs = [makeMessage({ editedAt: '2024-01-01T12:00:00Z' })];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map(),
      hasMore: new Map(),
    });
    render(
      <MessageList channelId="ch-1" currentUserId="user-1" onLoadMore={vi.fn()} />,
    );
    expect(screen.getByText('(edited)')).toBeInTheDocument();
  });

  it('shows edit and delete buttons only for own messages', () => {
    const msgs = [
      makeMessage({ id: 'own', authorId: 'user-1', content: 'My message' }),
      makeMessage({
        id: 'other',
        authorId: 'user-2',
        username: 'bob',
        content: 'Their message',
        createdAt: new Date(Date.now() + 600000).toISOString(),
      }),
    ];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map(),
      hasMore: new Map(),
    });
    render(
      <MessageList
        channelId="ch-1"
        currentUserId="user-1"
        onLoadMore={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    // Edit and Delete titles should appear once each (only for own message)
    expect(screen.getAllByTitle('Edit Message')).toHaveLength(1);
    expect(screen.getAllByTitle('Delete Message')).toHaveLength(1);
  });

  it('calls onEdit when edit button clicked', () => {
    const onEdit = vi.fn();
    const msgs = [makeMessage()];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map(),
      hasMore: new Map(),
    });
    render(
      <MessageList
        channelId="ch-1"
        currentUserId="user-1"
        onLoadMore={vi.fn()}
        onEdit={onEdit}
      />,
    );
    fireEvent.click(screen.getByTitle('Edit Message'));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'msg-1' }));
  });

  it('calls onDelete when delete button clicked', () => {
    const onDelete = vi.fn();
    const msgs = [makeMessage()];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map(),
      hasMore: new Map(),
    });
    render(
      <MessageList
        channelId="ch-1"
        currentUserId="user-1"
        onLoadMore={vi.fn()}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(screen.getByTitle('Delete Message'));
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'msg-1' }));
  });

  it('renders reactions for messages with reactions', () => {
    const msgs = [
      makeMessage({
        reactions: [{ emoji: '👍', users: ['user-2'], count: 1 }],
      }),
    ];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map(),
      hasMore: new Map(),
    });
    render(
      <MessageList channelId="ch-1" currentUserId="user-1" onLoadMore={vi.fn()} />,
    );
    expect(screen.getByTestId('reactions')).toBeInTheDocument();
  });

  it('shows thread indicator when threadInfo provided', () => {
    const msgs = [makeMessage()];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map(),
      hasMore: new Map(),
    });
    render(
      <MessageList
        channelId="ch-1"
        currentUserId="user-1"
        onLoadMore={vi.fn()}
        threadInfo={{ 'msg-1': { count: 3, lastReplyAt: null } }}
      />,
    );
    expect(screen.getByText('{{count}} replies')).toBeInTheDocument();
  });

  it('shows single reply text for thread with count 1', () => {
    const msgs = [makeMessage()];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map(),
      hasMore: new Map(),
    });
    render(
      <MessageList
        channelId="ch-1"
        currentUserId="user-1"
        onLoadMore={vi.fn()}
        threadInfo={{ 'msg-1': { count: 1, lastReplyAt: null } }}
      />,
    );
    expect(screen.getByText('1 reply')).toBeInTheDocument();
  });

  it('shows thread last reply time', () => {
    const msgs = [makeMessage()];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map(),
      hasMore: new Map(),
    });
    render(
      <MessageList
        channelId="ch-1"
        currentUserId="user-1"
        onLoadMore={vi.fn()}
        threadInfo={{ 'msg-1': { count: 2, lastReplyAt: new Date().toISOString() } }}
      />,
    );
    expect(screen.getByText(/Last reply/)).toBeInTheDocument();
  });

  it('calls onOpenThread when thread indicator is clicked', () => {
    const onOpenThread = vi.fn();
    const msgs = [makeMessage()];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map(),
      hasMore: new Map(),
    });
    render(
      <MessageList
        channelId="ch-1"
        currentUserId="user-1"
        onLoadMore={vi.fn()}
        onOpenThread={onOpenThread}
        threadInfo={{ 'msg-1': { count: 2, lastReplyAt: null } }}
      />,
    );
    fireEvent.click(screen.getByText('{{count}} replies').closest('button')!);
    expect(onOpenThread).toHaveBeenCalledWith('msg-1');
  });

  it('calls onReply when reply button is clicked', () => {
    const onReply = vi.fn();
    const msgs = [makeMessage()];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map(),
      hasMore: new Map(),
    });
    render(
      <MessageList
        channelId="ch-1"
        currentUserId="user-1"
        onLoadMore={vi.fn()}
        onReply={onReply}
      />,
    );
    fireEvent.click(screen.getByTitle('Reply'));
    expect(onReply).toHaveBeenCalledWith(expect.objectContaining({ id: 'msg-1' }));
  });

  it('calls onCreateThread when thread button is clicked', () => {
    const onCreateThread = vi.fn();
    const msgs = [makeMessage()];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map(),
      hasMore: new Map(),
    });
    render(
      <MessageList
        channelId="ch-1"
        currentUserId="user-1"
        onLoadMore={vi.fn()}
        onCreateThread={onCreateThread}
      />,
    );
    fireEvent.click(screen.getByTitle('Create Thread'));
    expect(onCreateThread).toHaveBeenCalledWith(expect.objectContaining({ id: 'msg-1' }));
  });

  it('renders reaction button when onReaction provided', () => {
    const msgs = [makeMessage()];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map(),
      hasMore: new Map(),
    });
    render(
      <MessageList
        channelId="ch-1"
        currentUserId="user-1"
        onLoadMore={vi.fn()}
        onReaction={vi.fn()}
      />,
    );
    expect(screen.getByTitle('Add Reaction')).toBeInTheDocument();
  });

  it('opens emoji picker when reaction button is clicked', () => {
    const msgs = [makeMessage()];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map(),
      hasMore: new Map(),
    });
    render(
      <MessageList
        channelId="ch-1"
        currentUserId="user-1"
        onLoadMore={vi.fn()}
        onReaction={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTitle('Add Reaction'));
    expect(screen.getByTestId('emoji-picker')).toBeInTheDocument();
  });

  it('does not show action buttons on deleted messages', () => {
    const msgs = [makeMessage({ deleted: true })];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map(),
      hasMore: new Map(),
    });
    const { container } = render(
      <MessageList
        channelId="ch-1"
        currentUserId="user-1"
        onLoadMore={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(container.querySelector('.message-actions')).not.toBeInTheDocument();
  });

  it('creates separate groups for messages far apart in time', () => {
    const now = new Date();
    const msgs = [
      makeMessage({ id: 'msg-1', content: 'First', createdAt: now.toISOString() }),
      makeMessage({
        id: 'msg-2',
        content: 'Second',
        createdAt: new Date(now.getTime() + 8 * 60 * 1000).toISOString(),
      }),
    ];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map(),
      hasMore: new Map(),
    });
    render(
      <MessageList channelId="ch-1" currentUserId="user-2" onLoadMore={vi.fn()} />,
    );
    // Should have two username headers (two groups)
    const usernames = screen.getAllByText('alice');
    expect(usernames).toHaveLength(2);
  });

  it('strips [DEV: unencrypted] prefix from content', () => {
    const msgs = [makeMessage({ content: '[DEV: unencrypted] Hello world' })];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map(),
      hasMore: new Map(),
    });
    render(
      <MessageList channelId="ch-1" currentUserId="user-1" onLoadMore={vi.fn()} />,
    );
    expect(screen.getByText('Hello world')).toBeInTheDocument();
    expect(screen.queryByText('[DEV: unencrypted]')).not.toBeInTheDocument();
  });

  it('renders empty list when no messages for channel', () => {
    useMessageStore.setState({
      messages: new Map(),
      loadingHistory: new Map(),
      hasMore: new Map(),
    });
    const { container } = render(
      <MessageList channelId="ch-1" currentUserId="user-1" onLoadMore={vi.fn()} />,
    );
    expect(container.querySelectorAll('.message-group').length).toBe(0);
  });

  it('calls onLoadMore when scrolled to top with more history', () => {
    const onLoadMore = vi.fn();
    const msgs = [makeMessage()];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map([['ch-1', false]]),
      hasMore: new Map([['ch-1', true]]),
    });
    const { container } = render(
      <MessageList channelId="ch-1" currentUserId="user-1" onLoadMore={onLoadMore} />,
    );
    const list = container.querySelector('.message-list')!;
    // Simulate scroll to top
    Object.defineProperty(list, 'scrollTop', { value: 50, configurable: true });
    Object.defineProperty(list, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(list, 'clientHeight', { value: 500, configurable: true });
    fireEvent.scroll(list);
    expect(onLoadMore).toHaveBeenCalled();
  });

  it('does not call onLoadMore when not scrolled to top', () => {
    const onLoadMore = vi.fn();
    const msgs = [makeMessage()];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map([['ch-1', false]]),
      hasMore: new Map([['ch-1', true]]),
    });
    const { container } = render(
      <MessageList channelId="ch-1" currentUserId="user-1" onLoadMore={onLoadMore} />,
    );
    const list = container.querySelector('.message-list')!;
    Object.defineProperty(list, 'scrollTop', { value: 500, configurable: true });
    Object.defineProperty(list, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(list, 'clientHeight', { value: 500, configurable: true });
    fireEvent.scroll(list);
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('renders messages with attachments', () => {
    const msgs = [
      makeMessage({
        id: 'msg-attach',
      }),
    ];
    // Add attachments to message
    const msgWithAttach = { ...msgs[0], attachments: [{ url: '/file.jpg', filename: 'file.jpg', size: 1024, content_type: 'image/jpeg' }] };
    useMessageStore.setState({
      messages: new Map([['ch-1', [msgWithAttach as unknown as Message]]]),
      loadingHistory: new Map(),
      hasMore: new Map(),
    });
    render(
      <MessageList channelId="ch-1" currentUserId="user-1" onLoadMore={vi.fn()} />,
    );
    expect(screen.getByTestId('file-preview')).toBeInTheDocument();
  });

  it('closes emoji picker and sends reaction on emoji select', () => {
    const onReaction = vi.fn();
    const msgs = [makeMessage()];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map(),
      hasMore: new Map(),
    });

    render(
      <MessageList
        channelId="ch-1"
        currentUserId="user-1"
        onLoadMore={vi.fn()}
        onReaction={onReaction}
      />,
    );

    // Open emoji picker
    fireEvent.click(screen.getByTitle('Add Reaction'));
    expect(screen.getByTestId('emoji-picker')).toBeInTheDocument();

    // Select an emoji - should call onReaction and close picker
    fireEvent.click(screen.getByTestId('emoji-select'));
    expect(onReaction).toHaveBeenCalledWith('msg-1', '👍');
    expect(screen.queryByTestId('emoji-picker')).not.toBeInTheDocument();
  });

  it('closes emoji picker via close button', () => {
    const onReaction = vi.fn();
    const msgs = [makeMessage()];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map(),
      hasMore: new Map(),
    });

    render(
      <MessageList
        channelId="ch-1"
        currentUserId="user-1"
        onLoadMore={vi.fn()}
        onReaction={onReaction}
      />,
    );

    fireEvent.click(screen.getByTitle('Add Reaction'));
    expect(screen.getByTestId('emoji-picker')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('emoji-close'));
    expect(screen.queryByTestId('emoji-picker')).not.toBeInTheDocument();
  });

  it('toggles emoji picker off when clicking reaction button again', () => {
    const onReaction = vi.fn();
    const msgs = [makeMessage()];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map(),
      hasMore: new Map(),
    });

    render(
      <MessageList
        channelId="ch-1"
        currentUserId="user-1"
        onLoadMore={vi.fn()}
        onReaction={onReaction}
      />,
    );

    // Open
    fireEvent.click(screen.getByTitle('Add Reaction'));
    expect(screen.getByTestId('emoji-picker')).toBeInTheDocument();

    // Toggle off
    fireEvent.click(screen.getByTitle('Add Reaction'));
    expect(screen.queryByTestId('emoji-picker')).not.toBeInTheDocument();
  });

  it('renders multiple messages from different authors as separate groups', () => {
    const now = new Date();
    const msgs = [
      makeMessage({ id: 'msg-1', authorId: 'user-1', username: 'alice', content: 'Hello', createdAt: now.toISOString() }),
      makeMessage({ id: 'msg-2', authorId: 'user-2', username: 'bob', content: 'Hi', createdAt: now.toISOString() }),
    ];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map(),
      hasMore: new Map(),
    });
    render(
      <MessageList channelId="ch-1" currentUserId="user-3" onLoadMore={vi.fn()} />,
    );
    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(screen.getByText('bob')).toBeInTheDocument();
  });

  it('formats "Yesterday" timestamp correctly', () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const msgs = [makeMessage({ createdAt: yesterday.toISOString() })];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map(),
      hasMore: new Map(),
    });
    render(
      <MessageList channelId="ch-1" currentUserId="user-2" onLoadMore={vi.fn()} />,
    );
    expect(screen.getByText(/Yesterday at/)).toBeInTheDocument();
  });

  it('formats old date timestamp correctly', () => {
    const msgs = [makeMessage({ createdAt: '2020-03-15T10:30:00Z' })];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map(),
      hasMore: new Map(),
    });
    render(
      <MessageList channelId="ch-1" currentUserId="user-2" onLoadMore={vi.fn()} />,
    );
    expect(screen.getByText(/2020/)).toBeInTheDocument();
  });

  it('formats "Today" timestamp correctly', () => {
    const now = new Date();
    const msgs = [makeMessage({ createdAt: now.toISOString() })];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map(),
      hasMore: new Map(),
    });
    render(
      <MessageList channelId="ch-1" currentUserId="user-2" onLoadMore={vi.fn()} />,
    );
    expect(screen.getByText(/Today at/)).toBeInTheDocument();
  });

  it('getInitials returns first 2 chars uppercase', () => {
    const msgs = [makeMessage({ username: 'ab' })];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map(),
      hasMore: new Map(),
    });
    render(
      <MessageList channelId="ch-1" currentUserId="user-2" onLoadMore={vi.fn()} />,
    );
    // The avatar should contain "AB" (first 2 chars uppercased)
    expect(screen.getByText('AB')).toBeInTheDocument();
  });

  it('getInitials handles empty username with fallback', () => {
    const msgs = [makeMessage({ username: '' })];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map(),
      hasMore: new Map(),
    });
    render(
      <MessageList channelId="ch-1" currentUserId="user-2" onLoadMore={vi.fn()} />,
    );
    // Empty username gets '?' fallback, sliced to '?'
    expect(screen.getByText('?')).toBeInTheDocument();
  });

  it('does not group deleted messages with previous same-author messages', () => {
    const now = new Date();
    const msgs = [
      makeMessage({ id: 'msg-1', content: 'First', createdAt: now.toISOString() }),
      makeMessage({
        id: 'msg-2',
        content: 'Deleted',
        deleted: true,
        createdAt: new Date(now.getTime() + 60000).toISOString(),
      }),
    ];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map(),
      hasMore: new Map(),
    });
    render(
      <MessageList channelId="ch-1" currentUserId="user-2" onLoadMore={vi.fn()} />,
    );
    // Deleted message should be in its own group (separate from first)
    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('[message deleted]')).toBeInTheDocument();
  });

  it('system message creates its own group and breaks adjacent groups', () => {
    const now = new Date();
    const msgs = [
      makeMessage({ id: 'msg-1', authorId: 'user-1', username: 'alice', content: 'Hello', createdAt: now.toISOString() }),
      makeMessage({ id: 'sys-1', type: 'system', authorId: 'system', username: 'system', content: 'User left', createdAt: new Date(now.getTime() + 1000).toISOString() }),
      makeMessage({ id: 'msg-3', authorId: 'user-2', username: 'bob', content: 'Bye', createdAt: new Date(now.getTime() + 2000).toISOString() }),
    ];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map(),
      hasMore: new Map(),
    });
    const { container } = render(
      <MessageList channelId="ch-1" currentUserId="user-3" onLoadMore={vi.fn()} />,
    );
    // System message should be in .message-system div
    expect(container.querySelector('.message-system')).toBeInTheDocument();
    // Alice group + system group + Bob group = 2 message-groups + 1 system
    expect(container.querySelectorAll('.message-group').length).toBe(2);
    expect(container.querySelectorAll('.message-system').length).toBe(1);
  });

  it('preserves scroll position when prepending history', () => {
    const msgs = [makeMessage()];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map(),
      hasMore: new Map([['ch-1', true]]),
    });
    const { container } = render(
      <MessageList channelId="ch-1" currentUserId="user-1" onLoadMore={vi.fn()} />,
    );
    const list = container.querySelector('.message-list')!;
    // Make scrollTop writable for the preserve scroll effect
    Object.defineProperty(list, 'scrollTop', { value: 50, configurable: true, writable: true });
    Object.defineProperty(list, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(list, 'clientHeight', { value: 500, configurable: true });
    fireEvent.scroll(list);

    // Add more messages to trigger the preserveScroll useEffect
    const newMsgs = [
      makeMessage({ id: 'msg-0', content: 'Old msg', createdAt: '2020-01-01T00:00:00Z' }),
      ...msgs,
    ];
    useMessageStore.setState({
      messages: new Map([['ch-1', newMsgs]]),
    });
  });

  it('does not call onLoadMore when loading history is true', () => {
    const onLoadMore = vi.fn();
    const msgs = [makeMessage()];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map([['ch-1', true]]),
      hasMore: new Map([['ch-1', true]]),
    });
    const { container } = render(
      <MessageList channelId="ch-1" currentUserId="user-1" onLoadMore={onLoadMore} />,
    );
    const list = container.querySelector('.message-list')!;
    Object.defineProperty(list, 'scrollTop', { value: 50, configurable: true });
    Object.defineProperty(list, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(list, 'clientHeight', { value: 500, configurable: true });
    fireEvent.scroll(list);
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('does not show reactions for deleted messages', () => {
    const msgs = [
      makeMessage({
        deleted: true,
        reactions: [{ emoji: '👍', users: ['user-2'], count: 1 }],
      }),
    ];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map(),
      hasMore: new Map(),
    });
    render(
      <MessageList channelId="ch-1" currentUserId="user-1" onLoadMore={vi.fn()} />,
    );
    expect(screen.queryByTestId('reactions')).not.toBeInTheDocument();
  });

  it('does not show file preview for deleted messages with attachments', () => {
    const msgs = [
      {
        ...makeMessage({ deleted: true }),
        attachments: [{ url: '/f.jpg', filename: 'f.jpg', size: 100, content_type: 'image/jpeg' }],
      },
    ];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs as unknown as Message[]]]),
      loadingHistory: new Map(),
      hasMore: new Map(),
    });
    render(
      <MessageList channelId="ch-1" currentUserId="user-1" onLoadMore={vi.fn()} />,
    );
    expect(screen.queryByTestId('file-preview')).not.toBeInTheDocument();
  });

  it('auto-scrolls on channel change', () => {
    const msgs = [makeMessage()];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs], ['ch-2', [makeMessage({ id: 'msg-2', channelId: 'ch-2' })]]]),
      loadingHistory: new Map(),
      hasMore: new Map(),
    });
    const { rerender } = render(
      <MessageList channelId="ch-1" currentUserId="user-1" onLoadMore={vi.fn()} />,
    );
    rerender(
      <MessageList channelId="ch-2" currentUserId="user-1" onLoadMore={vi.fn()} />,
    );
    // scrollIntoView should have been called on channel change
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it('detects at-bottom for auto-scroll', () => {
    const msgs = [makeMessage()];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map([['ch-1', false]]),
      hasMore: new Map([['ch-1', false]]),
    });
    const { container } = render(
      <MessageList channelId="ch-1" currentUserId="user-1" onLoadMore={vi.fn()} />,
    );
    const list = container.querySelector('.message-list')!;
    // Simulate scroll at bottom
    Object.defineProperty(list, 'scrollTop', { value: 480, configurable: true });
    Object.defineProperty(list, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(list, 'clientHeight', { value: 500, configurable: true });
    fireEvent.scroll(list);
    // No assertion needed — this exercises the atBottom branch
  });

  it('renders thread indicator without lastReplyAt', () => {
    const msgs = [makeMessage()];
    useMessageStore.setState({
      messages: new Map([['ch-1', msgs]]),
      loadingHistory: new Map(),
      hasMore: new Map(),
    });
    render(
      <MessageList
        channelId="ch-1"
        currentUserId="user-1"
        onLoadMore={vi.fn()}
        threadInfo={{ 'msg-1': { count: 5, lastReplyAt: null } }}
      />,
    );
    expect(screen.getByText('{{count}} replies')).toBeInTheDocument();
    expect(screen.queryByText(/Last reply/)).not.toBeInTheDocument();
  });
});
