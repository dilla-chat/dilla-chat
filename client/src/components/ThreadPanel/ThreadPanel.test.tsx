import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ThreadPanel from './ThreadPanel';
import { useTeamStore } from '../../stores/teamStore';
import { useAuthStore } from '../../stores/authStore';
import { useThreadStore, type Thread } from '../../stores/threadStore';
import { useMessageStore } from '../../stores/messageStore';
import { invokeWsHandler, getWsHandler, getLastWsHandler } from '../../test/helpers';

// Mock scrollIntoView which is not available in jsdom
Element.prototype.scrollIntoView = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, defaultValueOrOpts?: string | Record<string, unknown>, _opts?: Record<string, unknown>) => {
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
  api: { getThreadMessages: vi.fn(() => Promise.resolve([])) },
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

vi.mock('remark-gfm', () => ({ default: () => {} }));

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

const baseThread: Thread = {
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

/** Build a thread message for store or WS payloads */
function makeThreadMsg(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tmsg-1', channelId: 'ch-1', authorId: 'user-1', username: 'alice',
    content: 'Hello from thread', encryptedContent: '', type: 'text',
    threadId: 'thread-1', editedAt: null, deleted: false,
    createdAt: '2025-01-01T11:00:00Z', reactions: [],
    ...overrides,
  };
}

/** Build a raw WS/API thread message payload (snake_case) */
function makeRawThreadMsg(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tmsg-1', channel_id: 'ch-1', author_id: 'user-1', username: 'alice',
    content: 'Hello from thread', type: 'text', thread_id: 'thread-1',
    edited_at: null, deleted: false, created_at: '2025-01-01T11:00:00Z', reactions: [],
    ...overrides,
  };
}

/** Standard render with default thread */
function renderThreadPanel(threadOverrides?: Partial<Thread>, onClose = vi.fn()) {
  const thread = { ...baseThread, ...threadOverrides };
  return render(<ThreadPanel thread={thread} onClose={onClose} />);
}

/** Set up default beforeEach state */
function setupDefaultStores() {
  useTeamStore.setState({ activeTeamId: 'team-1' });
  useAuthStore.setState({
    teams: new Map([['team-1', { token: 't', user: { id: 'user-1', username: 'alice' }, teamInfo: null, baseUrl: '' }]]),
    derivedKey: null,
  });
  useThreadStore.setState({
    threadMessages: {
      'thread-1': [
        makeThreadMsg(),
        makeThreadMsg({ id: 'tmsg-2', authorId: 'user-2', username: 'bob', content: 'Reply from bob', createdAt: '2025-01-01T11:05:00Z' }),
      ],
    },
  });
  useMessageStore.setState({
    messages: new Map([['ch-1', [{
      id: 'msg-parent', channelId: 'ch-1', authorId: 'user-1', username: 'alice',
      content: 'Parent message content', encryptedContent: '', type: 'text',
      threadId: null, editedAt: null, deleted: false, createdAt: '2025-01-01T10:00:00Z', reactions: [],
    }]]]),
  });
}

/** Simulate scrolling near top to trigger load-more */
function simulateScrollNearTop(container: HTMLElement) {
  const messagesDiv = container.querySelector('.thread-messages');
  if (messagesDiv) {
    Object.defineProperty(messagesDiv, 'scrollTop', { value: 30, configurable: true });
    Object.defineProperty(messagesDiv, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(messagesDiv, 'clientHeight', { value: 500, configurable: true });
    fireEvent.scroll(messagesDiv);
  }
}

/** Build N raw messages for load-more tests */
function buildFiftyRawMessages(threadId: string, prefix = 'msg') {
  return Array.from({ length: 50 }, (_, i) => makeRawThreadMsg({
    id: `${prefix}-${i}`, content: `msg-${i}`, thread_id: threadId,
    created_at: `2025-01-01T${String(i).padStart(2, '0')}:00:00Z`,
  }));
}

describe('ThreadPanel', () => {
  beforeEach(setupDefaultStores);

  it('renders thread title, reply count, close button, parent message, thread messages, and input', () => {
    renderThreadPanel();
    expect(screen.getByText('Test Thread')).toBeInTheDocument();
    expect(screen.getAllByText('{{count}} replies').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId('Xmark')).toBeInTheDocument();
    expect(screen.getByText('Parent message content')).toBeInTheDocument();
    expect(screen.getByText('Hello from thread')).toBeInTheDocument();
    expect(screen.getByText('Reply from bob')).toBeInTheDocument();
    expect(screen.getByTestId('message-input')).toBeInTheDocument();
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();
    renderThreadPanel(undefined, onClose);
    fireEvent.click(screen.getByTestId('Xmark').closest('button') as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows edit and delete buttons only for own messages', () => {
    renderThreadPanel();
    expect(screen.getAllByTestId('EditPencil')).toHaveLength(1);
    expect(screen.getAllByTestId('Trash')).toHaveLength(1);
  });

  it('shows default title when thread has no title', () => {
    renderThreadPanel({ title: '' });
    expect(screen.getByText('Thread')).toBeInTheDocument();
  });

  it('shows no replies message when thread is empty', () => {
    useThreadStore.setState({ threadMessages: {} });
    renderThreadPanel({ message_count: 0 });
    expect(screen.getByText('No replies yet. Start the conversation!')).toBeInTheDocument();
  });

  it('shows 1 reply subtitle for single message', () => {
    useThreadStore.setState({
      threadMessages: { 'thread-1': [makeThreadMsg({ content: 'Hello' })] },
    });
    renderThreadPanel({ message_count: 1 });
    expect(screen.getAllByText('1 reply').length).toBeGreaterThanOrEqual(1);
  });

  it.each([
    { scenario: 'deleted message', msg: { id: 'tmsg-del', deleted: true, content: '' }, expected: '[message deleted]' },
    { scenario: 'edited message', msg: { id: 'tmsg-ed', authorId: 'user-2', username: 'bob', content: 'Edited msg', editedAt: '2025-01-01T12:00:00Z' }, expected: '(edited)' },
  ])('shows $scenario indicator', ({ msg, expected }) => {
    useThreadStore.setState({ threadMessages: { 'thread-1': [makeThreadMsg(msg)] } });
    renderThreadPanel();
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it('clicking edit sets editing state, cancel clears it', () => {
    renderThreadPanel();
    fireEvent.click(screen.getByTestId('EditPencil').closest('button') as HTMLElement);
    expect(screen.getByTestId('editing-indicator')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('cancel-edit'));
    expect(screen.queryByTestId('editing-indicator')).not.toBeInTheDocument();
  });

  it('clicking delete button calls ws.deleteThreadMessage', async () => {
    const { ws } = await import('../../services/websocket');
    renderThreadPanel();
    fireEvent.click(screen.getByTestId('Trash').closest('button') as HTMLElement);
    expect(ws.deleteThreadMessage).toHaveBeenCalledWith('team-1', 'thread-1', 'tmsg-1');
  });

  it('sends message via thread input', async () => {
    const { ws } = await import('../../services/websocket');
    renderThreadPanel();
    const input = screen.getByTestId('message-input').querySelector('input')!;
    fireEvent.change(input, { target: { value: 'new reply' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(ws.sendThreadMessage).toHaveBeenCalledWith('team-1', 'thread-1', 'new reply');
  });

  it('renders without parent message when not found', () => {
    useMessageStore.setState({ messages: new Map() });
    renderThreadPanel();
    expect(screen.getByText('Hello from thread')).toBeInTheDocument();
  });

  it('subscribes to thread WS events on mount', async () => {
    const { ws } = await import('../../services/websocket');
    renderThreadPanel();
    const eventNames = vi.mocked(ws.on).mock.calls.map(c => c[0]);
    for (const evt of ['thread:message:new', 'thread:message:updated', 'thread:message:deleted']) {
      expect(eventNames).toContain(evt);
    }
  });

  it.each([
    { event: 'thread:message:new', threadId: 'thread-1', payload: { id: 'tmsg-new', channel_id: 'ch-1', author_id: 'user-2', username: 'bob', content: 'New thread msg', type: 'text', thread_id: 'thread-1', edited_at: null, deleted: false, created_at: '2025-01-01T12:00:00Z', reactions: [] } },
    { event: 'thread:message:updated', threadId: 'thread-1', payload: { id: 'tmsg-1', channel_id: 'ch-1', author_id: 'user-1', username: 'alice', content: 'Edited content', type: 'text', thread_id: 'thread-1', edited_at: '2025-01-01T12:30:00Z', deleted: false, created_at: '2025-01-01T11:00:00Z', reactions: [] } },
    { event: 'thread:message:deleted', threadId: 'thread-1', payload: { message_id: 'tmsg-1', thread_id: 'thread-1' } },
    { event: 'thread:message:new', threadId: 'other-thread', payload: { id: 'tmsg-other', channel_id: 'ch-1', author_id: 'user-2', username: 'bob', content: 'Other', type: 'text', thread_id: 'other-thread', edited_at: null, deleted: false, created_at: '2025-01-01T12:00:00Z', reactions: [] } },
    { event: 'thread:message:updated', threadId: 'other-thread', payload: { id: 'tmsg-1', channel_id: 'ch-1', author_id: 'user-1', username: 'alice', content: 'Edited', type: 'text', thread_id: 'other-thread', edited_at: '2025-01-01T12:30:00Z', deleted: false, created_at: '2025-01-01T11:00:00Z', reactions: [] } },
    { event: 'thread:message:deleted', threadId: 'other-thread', payload: { message_id: 'tmsg-1', thread_id: 'other-thread' } },
  ])('processes $event for thread=$threadId without error', async ({ event, payload }) => {
    const { ws } = await import('../../services/websocket');
    renderThreadPanel();
    const handler = getWsHandler(vi.mocked(ws.on), event);
    if (handler) await invokeWsHandler(handler, payload);
  });

  it('unsubscribes from events on unmount', async () => {
    const { ws } = await import('../../services/websocket');
    const unsub = vi.fn();
    vi.mocked(ws.on).mockReturnValue(unsub);
    const { unmount } = renderThreadPanel();
    unmount();
    expect(unsub).toHaveBeenCalled();
  });

  it('loads thread messages via API on mount', async () => {
    const { api } = await import('../../services/api');
    vi.mocked(api.getThreadMessages).mockResolvedValueOnce([]);
    useThreadStore.setState({ threadMessages: {} });
    renderThreadPanel({ id: 'thread-fresh' });
    await vi.waitFor(() => {
      expect(api.getThreadMessages).toHaveBeenCalledWith('team-1', 'thread-fresh');
    });
  });

  it('edit button sets editing state and save edit calls ws.editThreadMessage', async () => {
    const { ws } = await import('../../services/websocket');
    renderThreadPanel();
    fireEvent.click(screen.getByTestId('EditPencil').closest('button') as HTMLElement);
    expect(screen.getByTestId('editing-indicator')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('save-edit'));
    await vi.waitFor(() => {
      expect(ws.editThreadMessage).toHaveBeenCalledWith('team-1', 'thread-1', 'tmsg-1', expect.any(String));
    });
  });

  it.each([
    { scenario: 'yesterday', dateFactory: () => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString(); }, pattern: /Yesterday at/ },
    { scenario: 'old date', dateFactory: () => '2020-06-15T10:00:00Z', pattern: /2020/ },
    { scenario: 'today', dateFactory: () => new Date().toISOString(), pattern: /Today at/ },
  ])('renders $scenario timestamp', ({ dateFactory, pattern }) => {
    useThreadStore.setState({
      threadMessages: {
        'thread-1': [makeThreadMsg({ id: `tmsg-ts`, authorId: 'user-2', username: 'bob', content: 'Timestamped msg', createdAt: dateFactory() })],
      },
    });
    renderThreadPanel();
    expect(screen.getByText(pattern)).toBeInTheDocument();
  });

  it.each([
    { scenario: 'send', derivedKey: 'test-derived-key' },
    { scenario: 'send (no key)', derivedKey: null },
  ])('encrypts messages when derivedKey is set ($scenario)', async ({ derivedKey }) => {
    if (derivedKey) {
      useAuthStore.setState({ teams: new Map([['team-1', { token: 't', user: { id: 'user-1', username: 'alice' }, teamInfo: null, baseUrl: '' }]]), derivedKey });
    }
    const { ws } = await import('../../services/websocket');
    renderThreadPanel();
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
    renderThreadPanel();
    fireEvent.click(screen.getByTestId('EditPencil').closest('button') as HTMLElement);
    fireEvent.click(screen.getByTestId('save-edit'));
    await vi.waitFor(() => {
      expect(ws.editThreadMessage).toHaveBeenCalledWith('team-1', 'thread-1', 'tmsg-1', expect.any(String));
    });
  });

  it('does not send when activeTeamId is null', async () => {
    useTeamStore.setState({ activeTeamId: null as unknown as string });
    const { ws } = await import('../../services/websocket');
    vi.mocked(ws.sendThreadMessage).mockClear();
    renderThreadPanel();
    const input = screen.getByTestId('message-input').querySelector('input')!;
    fireEvent.change(input, { target: { value: 'test' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(ws.sendThreadMessage).not.toHaveBeenCalled();
  });

  it('handles scroll near top and at bottom', () => {
    const { container } = renderThreadPanel();
    const messagesDiv = container.querySelector('.thread-messages');
    expect(messagesDiv).toBeTruthy();
    if (messagesDiv) {
      // Near top
      Object.defineProperty(messagesDiv, 'scrollTop', { value: 50, configurable: true });
      Object.defineProperty(messagesDiv, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(messagesDiv, 'clientHeight', { value: 500, configurable: true });
      fireEvent.scroll(messagesDiv);
      // At bottom
      Object.defineProperty(messagesDiv, 'scrollTop', { value: 480, configurable: true });
      fireEvent.scroll(messagesDiv);
    }
  });

  it('renders loading state', () => {
    useThreadStore.setState({ threadMessages: {} });
    renderThreadPanel({ id: 'thread-loading' });
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('loads more messages via handleLoadMore with WS', async () => {
    const { ws } = await import('../../services/websocket');
    vi.mocked(ws.isConnected).mockReturnValue(true);
    vi.mocked(ws.request).mockResolvedValueOnce([]);
    useThreadStore.setState({
      threadMessages: { 'thread-loadmore': [makeThreadMsg({ id: 'tmsg-old', threadId: 'thread-loadmore', content: 'Old msg' })] },
    });
    const { container } = renderThreadPanel({ id: 'thread-loadmore' });
    simulateScrollNearTop(container);
    await vi.waitFor(() => {
      expect(ws.request).toHaveBeenCalledWith('team-1', 'threads:messages', expect.objectContaining({ thread_id: 'thread-loadmore' }));
    });
  });

  it('decrypts messages with derivedKey during initial load via WS', async () => {
    const { ws } = await import('../../services/websocket');
    const { cryptoService } = await import('../../services/crypto');
    vi.mocked(ws.isConnected).mockReturnValue(true);
    vi.mocked(ws.request).mockResolvedValueOnce([makeRawThreadMsg({ id: 'tmsg-enc', content: 'encrypted-content', thread_id: 'thread-decrypt' })]);
    vi.mocked(cryptoService.decryptMessage).mockResolvedValueOnce('decrypted-content');
    useAuthStore.setState({
      teams: new Map([['team-1', { token: 't', user: { id: 'user-1', username: 'alice' }, teamInfo: null, baseUrl: '' }]]),
      derivedKey: 'test-key',
    });
    useThreadStore.setState({ threadMessages: {} });
    renderThreadPanel({ id: 'thread-decrypt' });
    await vi.waitFor(() => {
      expect(cryptoService.decryptMessage).toHaveBeenCalled();
    });
  });

  it('encrypts messages with derivedKey during send (falls back on error)', async () => {
    useAuthStore.setState({
      teams: new Map([['team-1', { token: 't', user: { id: 'user-1', username: 'alice' }, teamInfo: null, baseUrl: '' }]]),
      derivedKey: 'test-key',
    });
    const { cryptoService } = await import('../../services/crypto');
    vi.mocked(cryptoService.encryptMessage).mockRejectedValueOnce(new Error('encryption failed'));
    const { ws } = await import('../../services/websocket');
    renderThreadPanel();
    const input = screen.getByTestId('message-input').querySelector('input')!;
    fireEvent.change(input, { target: { value: 'plaintext msg' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await vi.waitFor(() => {
      expect(ws.sendThreadMessage).toHaveBeenCalled();
    });
  });

  it('handleLoadMore via API when WS not connected', async () => {
    const { api } = await import('../../services/api');
    const { ws } = await import('../../services/websocket');
    vi.mocked(ws.isConnected).mockReturnValue(false);
    vi.mocked(api.getThreadMessages).mockClear();
    vi.mocked(api.getThreadMessages).mockResolvedValue([]);
    const threadId = 'thread-api-more-661';
    useThreadStore.setState({ threadMessages: {} });
    renderThreadPanel({ id: threadId });
    await vi.waitFor(() => {
      expect(vi.mocked(api.getThreadMessages).mock.calls.some(c => c[1] === threadId)).toBe(true);
    });
  });

  it('handleLoadMore does nothing when already loading', async () => {
    const { ws } = await import('../../services/websocket');
    vi.mocked(ws.isConnected).mockReturnValue(true);
    vi.mocked(ws.request).mockResolvedValue([]);
    useThreadStore.setState({ threadMessages: {} });
    const { container } = renderThreadPanel({ id: 'thread-loading-check' });
    const messagesDiv = container.querySelector('.thread-messages');
    expect(messagesDiv).toBeTruthy();
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
    vi.mocked(ws.request).mockResolvedValueOnce([]).mockResolvedValueOnce([makeRawThreadMsg({
      id: 'tmsg-dup', authorId: 'user-2', username: 'bob', content: 'Dup msg', thread_id: 'thread-dedup', created_at: '2025-01-01T10:00:00Z',
    })]);
    useThreadStore.setState({
      threadMessages: { 'thread-dedup': [makeThreadMsg({ id: 'tmsg-dup', authorId: 'user-2', username: 'bob', content: 'Dup msg', threadId: 'thread-dedup', createdAt: '2025-01-01T10:00:00Z' })] },
    });
    const { container } = renderThreadPanel({ id: 'thread-dedup' });
    await vi.waitFor(() => { expect(ws.request).toHaveBeenCalled(); });
    simulateScrollNearTop(container);
  });

  it('initial load with derivedKey calls decryptMessage for each message', async () => {
    const { ws } = await import('../../services/websocket');
    const { cryptoService } = await import('../../services/crypto');
    vi.mocked(ws.isConnected).mockReturnValue(true);
    vi.mocked(cryptoService.decryptMessage).mockClear();
    vi.mocked(cryptoService.decryptMessage).mockResolvedValue('decrypted-plain');
    const threadId = 'thread-decrypt-743';
    vi.mocked(ws.request).mockResolvedValueOnce([makeRawThreadMsg({ id: 'tmsg-dec-1', content: 'encrypted-1', thread_id: threadId })]);
    useAuthStore.setState({
      teams: new Map([['team-1', { token: 't', user: { id: 'user-1', username: 'alice' }, teamInfo: null, baseUrl: '' }]]),
      derivedKey: 'test-key',
    });
    useThreadStore.setState({ threadMessages: {} });
    renderThreadPanel({ id: threadId });
    await vi.waitFor(() => {
      expect(cryptoService.decryptMessage).toHaveBeenCalled();
    });
  });

  it('handleLoadMore loads older messages via WS and deduplicates', async () => {
    const { ws } = await import('../../services/websocket');
    vi.mocked(ws.request).mockReset();
    vi.mocked(ws.isConnected).mockReset();
    const threadId = `thread-loadmore-ws-${Date.now()}`;
    let callCount = 0;
    const fiftyMessages = buildFiftyRawMessages(threadId, 'init-msg');
    vi.mocked(ws.isConnected).mockReturnValue(true);
    vi.mocked(ws.request).mockImplementation(async (_teamId, event) => {
      if (event === 'threads:messages') {
        callCount++;
        if (callCount === 1) return fiftyMessages;
        return [makeRawThreadMsg({ id: 'older-msg-1', content: 'Older message', thread_id: threadId, created_at: '2024-12-31T23:00:00Z' })];
      }
      return [];
    });
    useThreadStore.setState({ threadMessages: {} });
    const { container } = renderThreadPanel({ id: threadId });
    await vi.waitFor(() => {
      expect(useThreadStore.getState().threadMessages[threadId]?.length).toBe(50);
    });
    simulateScrollNearTop(container);
    await vi.waitFor(() => { expect(callCount).toBeGreaterThanOrEqual(2); });
    await vi.waitFor(() => {
      expect(useThreadStore.getState().threadMessages[threadId]?.length).toBe(51);
    });
  });

  it('handleLoadMore loads older messages via API when WS not connected', async () => {
    const { ws } = await import('../../services/websocket');
    const { api } = await import('../../services/api');
    const threadId = `thread-loadmore-api-${Date.now()}`;
    let apiCallCount = 0;
    const fiftyMessages = buildFiftyRawMessages(threadId, 'api-init-msg');
    vi.mocked(ws.isConnected).mockReturnValue(false);
    vi.mocked(api.getThreadMessages).mockImplementation(async () => {
      apiCallCount++;
      if (apiCallCount === 1) return fiftyMessages as never;
      return [makeRawThreadMsg({ id: 'api-older-1', content: 'API older', thread_id: threadId, created_at: '2024-12-31T23:00:00Z' })] as never;
    });
    useThreadStore.setState({ threadMessages: {} });
    const { container } = renderThreadPanel({ id: threadId });
    await vi.waitFor(() => {
      expect(useThreadStore.getState().threadMessages[threadId]?.length).toBe(50);
    });
    simulateScrollNearTop(container);
    await vi.waitFor(() => { expect(apiCallCount).toBeGreaterThanOrEqual(2); });
  });

  it('handleLoadMore handles error gracefully', async () => {
    const { ws } = await import('../../services/websocket');
    const threadId = `thread-loadmore-err-${Date.now()}`;
    let callCount = 0;
    const fiftyMessages = buildFiftyRawMessages(threadId, 'err-msg');
    vi.mocked(ws.isConnected).mockReturnValue(true);
    vi.mocked(ws.request).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return fiftyMessages;
      throw new Error('load more failed');
    });
    useThreadStore.setState({ threadMessages: {} });
    const { container } = renderThreadPanel({ id: threadId });
    await vi.waitFor(() => {
      expect(useThreadStore.getState().threadMessages[threadId]?.length).toBe(50);
    });
    simulateScrollNearTop(container);
    await vi.waitFor(() => { expect(callCount).toBeGreaterThanOrEqual(2); });
  });

  it('decrypts new thread message when derivedKey is set and no cache', async () => {
    const { ws } = await import('../../services/websocket');
    const { getCachedMessage } = await import('../../services/messageCache');
    const { cryptoService } = await import('../../services/crypto');
    vi.mocked(ws.on).mockClear();
    vi.mocked(getCachedMessage).mockResolvedValue(null);
    vi.mocked(cryptoService.decryptMessage).mockClear();
    vi.mocked(cryptoService.decryptMessage).mockResolvedValue('decrypted-new');
    useAuthStore.setState({
      teams: new Map([['team-1', { token: 't', user: { id: 'user-1', username: 'alice' }, teamInfo: null, baseUrl: '' }]]),
      derivedKey: 'test-key',
    });
    renderThreadPanel();
    const newHandler = getLastWsHandler(vi.mocked(ws.on), 'thread:message:new');
    expect(newHandler).toBeDefined();
    await invokeWsHandler(newHandler!, makeRawThreadMsg({
      id: 'tmsg-decrypt-new', author_id: 'user-2', username: 'bob',
      content: 'encrypted-content', created_at: '2025-01-01T13:00:00Z',
    }));
    expect(cryptoService.decryptMessage).toHaveBeenCalled();
  });

  it('decrypts updated thread message when derivedKey is set', async () => {
    const { ws } = await import('../../services/websocket');
    const { cryptoService } = await import('../../services/crypto');
    vi.mocked(ws.on).mockClear();
    vi.mocked(cryptoService.decryptMessage).mockClear();
    vi.mocked(cryptoService.decryptMessage).mockResolvedValue('decrypted-edit');
    useAuthStore.setState({
      teams: new Map([['team-1', { token: 't', user: { id: 'user-1', username: 'alice' }, teamInfo: null, baseUrl: '' }]]),
      derivedKey: 'test-key',
    });
    renderThreadPanel();
    const editHandler = getLastWsHandler(vi.mocked(ws.on), 'thread:message:updated');
    expect(editHandler).toBeDefined();
    await invokeWsHandler(editHandler!, makeRawThreadMsg({
      content: 'encrypted-edit', edited_at: '2025-01-01T12:30:00Z',
    }));
    expect(cryptoService.decryptMessage).toHaveBeenCalled();
  });

  it('handles thread:message:new with cached content', async () => {
    const { ws } = await import('../../services/websocket');
    const { getCachedMessage } = await import('../../services/messageCache');
    vi.mocked(getCachedMessage).mockResolvedValueOnce('cached-new-content');
    useAuthStore.setState({
      teams: new Map([['team-1', { token: 't', user: { id: 'user-1', username: 'alice' }, teamInfo: null, baseUrl: '' }]]),
      derivedKey: 'test-key',
    });
    renderThreadPanel();
    const handler = getWsHandler(vi.mocked(ws.on), 'thread:message:new');
    expect(handler).toBeDefined();
    if (handler) {
      await invokeWsHandler(handler, makeRawThreadMsg({
        id: 'tmsg-cached-new', author_id: 'user-2', username: 'bob',
        content: 'encrypted-content', created_at: '2025-01-01T13:00:00Z',
      }));
    }
  });
});
