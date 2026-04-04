import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SearchBar from './SearchBar';

// Mock iconoir-react
vi.mock('iconoir-react', () => ({
  Search: () => <span data-testid="search-icon" />,
  Xmark: () => <span data-testid="xmark-icon" />,
}));

describe('SearchBar', () => {
  it('renders input with placeholder', () => {
    render(<SearchBar />);
    expect(screen.getByPlaceholderText('Search messages...')).toBeInTheDocument();
  });

  it('typing updates the input value', async () => {
    const user = userEvent.setup();
    render(<SearchBar />);
    const input = screen.getByPlaceholderText('Search messages...');
    await user.type(input, 'hello');
    expect(input).toHaveValue('hello');
  });

  it('Escape clears the input', async () => {
    const user = userEvent.setup();
    render(<SearchBar />);
    const input = screen.getByPlaceholderText('Search messages...');
    await user.type(input, 'test');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input).toHaveValue('');
  });

  it('shows clear button when query is non-empty', async () => {
    const user = userEvent.setup();
    render(<SearchBar />);
    const input = screen.getByPlaceholderText('Search messages...');
    await user.type(input, 'hello');
    expect(screen.getByTestId('xmark-icon')).toBeInTheDocument();
  });

  it('hides clear button when query is empty', () => {
    render(<SearchBar />);
    expect(screen.queryByTestId('xmark-icon')).not.toBeInTheDocument();
  });

  it('clears query when clear button is clicked', async () => {
    const user = userEvent.setup();
    render(<SearchBar />);
    const input = screen.getByPlaceholderText('Search messages...');
    await user.type(input, 'test');
    fireEvent.click(screen.getByTestId('xmark-icon').closest('button') as HTMLElement);
    expect(input).toHaveValue('');
  });

  it('shows search results when query matches messages', async () => {
    const { useMessageStore } = await import('../../stores/messageStore');
    useMessageStore.setState({
      messages: new Map([
        ['ch-1', [
          {
            id: 'msg-1', channelId: 'ch-1', authorId: 'u1', username: 'alice',
            content: 'Hello world test', encryptedContent: '', type: 'text',
            threadId: null, editedAt: null, deleted: false,
            createdAt: new Date().toISOString(), reactions: [],
          },
        ]],
      ]),
    });
    const user = userEvent.setup();
    render(<SearchBar />);
    const input = screen.getByPlaceholderText('Search messages...');
    await user.type(input, 'Hello');
    // Focus the input
    fireEvent.focus(input);

    // Wait for debounce
    await vi.waitFor(() => {
      expect(screen.getByText('alice')).toBeInTheDocument();
    }, { timeout: 1000 });
  });

  it('shows no results message when nothing matches', async () => {
    const { useMessageStore } = await import('../../stores/messageStore');
    useMessageStore.setState({
      messages: new Map([
        ['ch-1', [
          {
            id: 'msg-1', channelId: 'ch-1', authorId: 'u1', username: 'alice',
            content: 'Hello world', encryptedContent: '', type: 'text',
            threadId: null, editedAt: null, deleted: false,
            createdAt: new Date().toISOString(), reactions: [],
          },
        ]],
      ]),
    });
    const user = userEvent.setup();
    render(<SearchBar />);
    const input = screen.getByPlaceholderText('Search messages...');
    await user.type(input, 'zzzzz');
    fireEvent.focus(input);

    await vi.waitFor(() => {
      expect(screen.getByText('No results found')).toBeInTheDocument();
    }, { timeout: 1000 });
  });

  it('calls onJumpToMessage when a result is clicked', async () => {
    const { useMessageStore } = await import('../../stores/messageStore');
    useMessageStore.setState({
      messages: new Map([
        ['ch-1', [
          {
            id: 'msg-1', channelId: 'ch-1', authorId: 'u1', username: 'alice',
            content: 'Hello world', encryptedContent: '', type: 'text',
            threadId: null, editedAt: null, deleted: false,
            createdAt: new Date().toISOString(), reactions: [],
          },
        ]],
      ]),
    });
    const onJump = vi.fn();
    const user = userEvent.setup();
    render(<SearchBar onJumpToMessage={onJump} />);
    const input = screen.getByPlaceholderText('Search messages...');
    await user.type(input, 'Hello');
    fireEvent.focus(input);

    await vi.waitFor(() => {
      expect(screen.getByText('alice')).toBeInTheDocument();
    }, { timeout: 1000 });

    fireEvent.click(screen.getByText('alice').closest('[data-testid="search-result"]') as HTMLElement);
    expect(onJump).toHaveBeenCalledWith('ch-1', 'msg-1');
  });

  it('skips deleted messages in search', async () => {
    const { useMessageStore } = await import('../../stores/messageStore');
    useMessageStore.setState({
      messages: new Map([
        ['ch-1', [
          {
            id: 'msg-del', channelId: 'ch-1', authorId: 'u1', username: 'alice',
            content: 'deleted message', encryptedContent: '', type: 'text',
            threadId: null, editedAt: null, deleted: true,
            createdAt: new Date().toISOString(), reactions: [],
          },
        ]],
      ]),
    });
    const user = userEvent.setup();
    render(<SearchBar />);
    const input = screen.getByPlaceholderText('Search messages...');
    await user.type(input, 'deleted');
    fireEvent.focus(input);

    await vi.waitFor(() => {
      expect(screen.getByText('No results found')).toBeInTheDocument();
    }, { timeout: 1000 });
  });

  it('highlights matching text in results', async () => {
    const { useMessageStore } = await import('../../stores/messageStore');
    useMessageStore.setState({
      messages: new Map([
        ['ch-1', [
          {
            id: 'msg-1', channelId: 'ch-1', authorId: 'u1', username: 'alice',
            content: 'Hello world', encryptedContent: '', type: 'text',
            threadId: null, editedAt: null, deleted: false,
            createdAt: new Date().toISOString(), reactions: [],
          },
        ]],
      ]),
    });
    const user = userEvent.setup();
    const { container } = render(<SearchBar />);
    const input = screen.getByPlaceholderText('Search messages...');
    await user.type(input, 'Hello');
    fireEvent.focus(input);

    await vi.waitFor(() => {
      const mark = container.querySelector('[data-testid="search-highlight"]');
      expect(mark).toBeInTheDocument();
      expect(mark?.textContent).toBe('Hello');
    }, { timeout: 1000 });
  });

  it('shows result count', async () => {
    const { useMessageStore } = await import('../../stores/messageStore');
    useMessageStore.setState({
      messages: new Map([
        ['ch-1', [
          {
            id: 'msg-1', channelId: 'ch-1', authorId: 'u1', username: 'alice',
            content: 'Test message 1', encryptedContent: '', type: 'text',
            threadId: null, editedAt: null, deleted: false,
            createdAt: new Date().toISOString(), reactions: [],
          },
          {
            id: 'msg-2', channelId: 'ch-1', authorId: 'u1', username: 'alice',
            content: 'Test message 2', encryptedContent: '', type: 'text',
            threadId: null, editedAt: null, deleted: false,
            createdAt: new Date(Date.now() + 1000).toISOString(), reactions: [],
          },
        ]],
      ]),
    });
    const user = userEvent.setup();
    render(<SearchBar />);
    const input = screen.getByPlaceholderText('Search messages...');
    await user.type(input, 'Test');
    fireEvent.focus(input);

    await vi.waitFor(() => {
      expect(screen.getByText('{{count}} results')).toBeInTheDocument();
    }, { timeout: 1000 });
  });

  it('closes dropdown on outside click', async () => {
    const { useMessageStore } = await import('../../stores/messageStore');
    useMessageStore.setState({
      messages: new Map([
        ['ch-1', [
          {
            id: 'msg-1', channelId: 'ch-1', authorId: 'u1', username: 'alice',
            content: 'Hello world', encryptedContent: '', type: 'text',
            threadId: null, editedAt: null, deleted: false,
            createdAt: new Date().toISOString(), reactions: [],
          },
        ]],
      ]),
    });
    const user = userEvent.setup();
    render(<SearchBar />);
    const input = screen.getByPlaceholderText('Search messages...');
    await user.type(input, 'Hello');
    fireEvent.focus(input);

    await vi.waitFor(() => {
      expect(screen.getByText('alice')).toBeInTheDocument();
    }, { timeout: 1000 });

    // Click outside
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('alice')).not.toBeInTheDocument();
  });

  it('handles empty search query gracefully', async () => {
    const user = userEvent.setup();
    render(<SearchBar />);
    const input = screen.getByPlaceholderText('Search messages...');
    await user.type(input, 'a');
    // Then clear to empty
    await user.clear(input);
    // No dropdown should appear
    expect(screen.queryByText('No results found')).not.toBeInTheDocument();
  });

  it('adds focused class when input is focused', () => {
    const { container } = render(<SearchBar />);
    const input = screen.getByPlaceholderText('Search messages...');
    fireEvent.focus(input);
    expect(container.querySelector('[data-focused]')).toBeInTheDocument();
  });
});
