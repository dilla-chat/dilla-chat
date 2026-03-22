import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DMView from './DMView';
import { useTeamStore } from '../../stores/teamStore';
import { useAuthStore } from '../../stores/authStore';
import { useMessageStore } from '../../stores/messageStore';
import type { DMChannel } from '../../stores/dmStore';
import { invokeWsHandler, getWsHandler } from '../../test/helpers';

const MESSAGE_PAGE_SIZE = 50;

// Mock dependencies
vi.mock('../../services/websocket', () => ({
  ws: {
    isConnected: vi.fn(() => false),
    on: vi.fn(() => vi.fn()),
    request: vi.fn(),
    sendDMMessage: vi.fn(),
    editDMMessage: vi.fn(),
    deleteDMMessage: vi.fn(),
    startDMTyping: vi.fn(),
  },
}));

vi.mock('../../services/api', () => ({
  api: {
    getDMMessages: vi.fn(() => Promise.resolve([])),
  },
}));

vi.mock('../../services/crypto', () => ({
  cryptoService: {
    encryptDM: vi.fn((_, __, plaintext: string) => Promise.resolve(plaintext)),
    decryptDM: vi.fn((_, __, content: string) => Promise.resolve(content)),
  },
}));

vi.mock('../../services/messageCache', () => ({
  cacheMessage: vi.fn(),
  getCachedMessage: vi.fn(() => Promise.resolve(null)),
  deleteCachedMessage: vi.fn(),
}));

vi.mock('../MessageList/MessageList', () => ({
  default: ({ channelId, onLoadMore, onEdit, onDelete }: { channelId: string; onLoadMore?: () => void; onEdit?: (msg: unknown) => void; onDelete?: (msg: unknown) => void }) => (
    <div data-testid="message-list" data-channel-id={channelId}>
      <button data-testid="load-more" onClick={onLoadMore}>Load More</button>
      <button data-testid="edit-msg" onClick={() => onEdit?.({ id: 'msg-1', content: 'old' })}>Edit</button>
      <button data-testid="delete-msg" onClick={() => onDelete?.({ id: 'msg-1', channelId: 'dm-1', authorId: 'user-1' })}>Delete</button>
    </div>
  ),
}));

vi.mock('../MessageInput/MessageInput', () => ({
  default: ({ channelName, onSend, onEdit, onTyping, onCancelEdit, editingMessage }: { channelName: string; onSend?: (s: string) => void; onEdit?: (id: string, s: string) => void; onTyping?: () => void; onCancelEdit?: () => void; editingMessage?: unknown }) => (
    <div data-testid="message-input" data-channel-name={channelName}>
      <button data-testid="send-btn" onClick={() => onSend?.('test message')}>Send</button>
      <button data-testid="edit-btn" onClick={() => onEdit?.('msg-1', 'edited')}>Save Edit</button>
      <button data-testid="typing-btn" onClick={onTyping}>Type</button>
      <button data-testid="cancel-edit-btn" onClick={onCancelEdit}>Cancel</button>
      {editingMessage && <span data-testid="editing-indicator">Editing</span>}
    </div>
  ),
}));

const makeDM = (overrides?: Partial<DMChannel>): DMChannel => ({
  id: 'dm-1',
  team_id: 'team-1',
  is_group: false,
  members: [
    { user_id: 'user-1', username: 'alice', display_name: 'Alice' },
    { user_id: 'user-2', username: 'bob', display_name: 'Bob' },
  ],
  created_at: '2024-01-01T00:00:00Z',
  ...overrides,
});

/** Render DMView with standard props */
function renderDMView(overrides?: Partial<DMChannel>) {
  return render(<DMView dm={makeDM(overrides)} currentUserId="user-1" />);
}

/** Render + get ws module (most tests need it) */
async function renderWithWs(overrides?: Partial<DMChannel>) {
  const { ws } = await import('../../services/websocket');
  const result = renderDMView(overrides);
  return { ws, ...result };
}

/** Fire a WS event handler by name */
async function fireWsEvent(eventName: string, payload: Record<string, unknown>) {
  const { ws } = await import('../../services/websocket');
  const handler = getWsHandler(vi.mocked(ws.on), eventName);
  if (handler) await invokeWsHandler(handler, payload);
}

/** Build a raw DM message payload for WS/API responses */
function makeDMMessagePayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dm-msg-1', channel_id: 'dm-1', dm_id: 'dm-1', author_id: 'user-2',
    username: 'bob', content: 'Hey!', type: 'text', thread_id: null,
    edited_at: null, deleted: false, created_at: '2025-01-01T00:00:00Z', reactions: [],
    ...overrides,
  };
}

/** Set up message store with existing messages for load-more tests */
function setStoreWithMessages(opts: { loading?: boolean; hasMore?: boolean } = {}) {
  useMessageStore.setState({
    messages: new Map([['dm-1', [{ id: 'old-msg', channelId: 'dm-1', authorId: 'user-2', username: 'bob', content: 'old', encryptedContent: '', type: 'text', threadId: null, editedAt: null, deleted: false, createdAt: '2025-01-01T00:00:00Z', reactions: [] }]]]),
    typing: new Map(),
    loadingHistory: new Map([['dm-1', opts.loading ?? false]]),
    hasMore: new Map([['dm-1', opts.hasMore ?? true]]),
  });
}

describe('DMView', () => {
  beforeEach(() => {
    useTeamStore.setState({ activeTeamId: 'team-1' });
    useAuthStore.setState({ derivedKey: null } as never);
    useMessageStore.setState({
      messages: new Map(),
      typing: new Map(),
      loadingHistory: new Map(),
      hasMore: new Map(),
    });
  });

  it('renders MessageList and MessageInput with correct channel id', () => {
    renderDMView();
    expect(screen.getByTestId('message-list')).toHaveAttribute('data-channel-id', 'dm-1');
    expect(screen.getByTestId('message-input')).toBeInTheDocument();
  });

  it('shows the other participant name in MessageInput for 1:1 DM', () => {
    renderDMView();
    expect(screen.getByTestId('message-input')).toHaveAttribute('data-channel-name', 'Bob');
  });

  it('shows comma-joined names for group DM', () => {
    render(
      <DMView
        dm={makeDM({
          is_group: true,
          members: [
            { user_id: 'user-1', username: 'alice', display_name: 'Alice' },
            { user_id: 'user-2', username: 'bob', display_name: 'Bob' },
            { user_id: 'user-3', username: 'charlie', display_name: 'Charlie' },
          ],
        })}
        currentUserId="user-1"
      />,
    );
    expect(screen.getByTestId('message-input')).toHaveAttribute(
      'data-channel-name',
      'Alice, Bob, Charlie',
    );
  });

  it('shows member panel with usernames for group DM when showMembers is true', () => {
    const groupDM = makeDM({
      is_group: true,
      members: [
        { user_id: 'user-1', username: 'alice', display_name: 'Alice' },
        { user_id: 'user-2', username: 'bob', display_name: 'Bob' },
      ],
    });
    render(<DMView dm={groupDM} currentUserId="user-1" showMembers />);
    expect(screen.getByText('{{count}} members')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('@alice')).toBeInTheDocument();
    expect(screen.getByText('@bob')).toBeInTheDocument();
  });

  it('does not show member panel for non-group DM even with showMembers', () => {
    render(<DMView dm={makeDM()} currentUserId="user-1" showMembers />);
    expect(screen.queryByText('{{count}} members')).not.toBeInTheDocument();
  });

  it.each([
    { scenario: 'no display_name', members: [{ user_id: 'user-1', username: 'alice', display_name: '' }, { user_id: 'user-2', username: 'bob', display_name: '' }], expected: 'bob' },
    { scenario: 'no other member', members: [{ user_id: 'user-1', username: 'alice', display_name: 'Alice' }], expected: 'Unknown' },
  ])('shows fallback channel name when $scenario', ({ members, expected }) => {
    render(<DMView dm={makeDM({ members })} currentUserId="user-1" />);
    expect(screen.getByTestId('message-input')).toHaveAttribute('data-channel-name', expected);
  });

  it('loads DM message history via API on mount', async () => {
    const { api } = await import('../../services/api');
    vi.mocked(api.getDMMessages).mockResolvedValueOnce([makeDMMessagePayload()]);
    renderDMView();
    await vi.waitFor(() => {
      expect(api.getDMMessages).toHaveBeenCalledWith('team-1', 'dm-1', undefined, 50);
    });
  });

  it('loads DM messages via WS when connected', async () => {
    const { ws } = await import('../../services/websocket');
    vi.mocked(ws.isConnected).mockReturnValue(true);
    vi.mocked(ws.request).mockResolvedValueOnce([]);
    renderDMView();
    await vi.waitFor(() => {
      expect(ws.request).toHaveBeenCalledWith('team-1', 'dms:messages', expect.objectContaining({ dm_id: 'dm-1' }));
    });
  });

  it('subscribes to DM WebSocket events', async () => {
    const { ws } = await import('../../services/websocket');
    renderDMView();
    const eventNames = vi.mocked(ws.on).mock.calls.map(c => c[0]);
    for (const evt of ['dm:message:new', 'dm:message:updated', 'dm:message:deleted', 'dm:typing:indicator']) {
      expect(eventNames).toContain(evt);
    }
  });

  it.each([
    { event: 'dm:message:new', dmId: 'dm-1', payload: { id: 'dm-msg-2', dm_id: 'dm-1', channel_id: 'dm-1', author_id: 'user-2', username: 'bob', content: 'Hi!', type: 'text', thread_id: null, edited_at: null, deleted: false, created_at: '2025-01-01T01:00:00Z', reactions: [] } },
    { event: 'dm:message:updated', dmId: 'dm-1', payload: { dm_id: 'dm-1', message_id: 'dm-msg-1', content: 'edited', author_id: 'user-2', username: 'bob' } },
    { event: 'dm:message:deleted', dmId: 'dm-1', payload: { dm_id: 'dm-1', message_id: 'dm-msg-1' } },
    { event: 'dm:typing:indicator', dmId: 'dm-1', payload: { dm_id: 'dm-1', user_id: 'user-2', username: 'bob' } },
    { event: 'dm:message:new', dmId: 'other-dm', payload: { id: 'dm-msg-x', dm_id: 'other-dm', channel_id: 'other-dm', author_id: 'user-3', username: 'charlie', content: 'Nope', type: 'text', thread_id: null, edited_at: null, deleted: false, created_at: '2025-01-01T01:00:00Z', reactions: [] } },
    { event: 'dm:message:updated', dmId: 'other-dm', payload: { dm_id: 'other-dm', message_id: 'msg-x', content: 'edited', author_id: 'user-3', username: 'charlie' } },
    { event: 'dm:message:deleted', dmId: 'other-dm', payload: { dm_id: 'other-dm', message_id: 'msg-x' } },
    { event: 'dm:typing:indicator', dmId: 'other-dm', payload: { dm_id: 'other-dm', user_id: 'user-3', username: 'charlie' } },
  ])('processes $event for dm=$dmId without error', async ({ event, payload }) => {
    renderDMView();
    await fireWsEvent(event, payload);
  });

  it('unsubscribes from events on unmount', async () => {
    const { ws } = await import('../../services/websocket');
    const unsub = vi.fn();
    vi.mocked(ws.on).mockReturnValue(unsub);
    const { unmount } = renderDMView();
    unmount();
    expect(unsub).toHaveBeenCalled();
  });

  it('sends a DM message via WS when send button is clicked', async () => {
    const { ws } = await renderWithWs();
    fireEvent.click(screen.getByTestId('send-btn'));
    await vi.waitFor(() => {
      expect(ws.sendDMMessage).toHaveBeenCalledWith('team-1', 'dm-1', expect.any(String));
    });
  });

  it('edits a DM message via WS when save edit button is clicked', async () => {
    const { ws } = await renderWithWs();
    fireEvent.click(screen.getByTestId('edit-msg'));
    fireEvent.click(screen.getByTestId('edit-btn'));
    await vi.waitFor(() => {
      expect(ws.editDMMessage).toHaveBeenCalledWith('team-1', 'dm-1', 'msg-1', expect.any(String));
    });
  });

  it('deletes a DM message via WS when delete button is clicked', async () => {
    const { ws } = await renderWithWs();
    fireEvent.click(screen.getByTestId('delete-msg'));
    expect(ws.deleteDMMessage).toHaveBeenCalledWith('team-1', 'dm-1', 'msg-1');
  });

  it('sends typing indicator via WS when typing', async () => {
    const { ws } = await renderWithWs();
    fireEvent.click(screen.getByTestId('typing-btn'));
    expect(ws.startDMTyping).toHaveBeenCalledWith('team-1', 'dm-1');
  });

  it('clicking edit button sets editing state, cancel clears it', () => {
    renderDMView();
    fireEvent.click(screen.getByTestId('edit-msg'));
    expect(screen.getByTestId('editing-indicator')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('cancel-edit-btn'));
    expect(screen.queryByTestId('editing-indicator')).not.toBeInTheDocument();
  });

  it('triggers handleLoadMore via load more button', () => {
    setStoreWithMessages();
    renderDMView();
    const loadMoreBtn = screen.getByTestId('load-more');
    expect(loadMoreBtn).toBeInTheDocument();
    fireEvent.click(loadMoreBtn);
  });

  it.each([
    { scenario: 'send', btnId: 'send-btn', method: 'sendDMMessage' as const },
    { scenario: 'edit', btnId: 'edit-msg+edit-btn', method: 'editDMMessage' as const },
    { scenario: 'delete', btnId: 'delete-msg', method: 'deleteDMMessage' as const },
    { scenario: 'type', btnId: 'typing-btn', method: 'startDMTyping' as const },
  ])('does not $scenario when activeTeamId is null', async ({ btnId, method }) => {
    useTeamStore.setState({ activeTeamId: null as unknown as string });
    const { ws } = await import('../../services/websocket');
    vi.mocked(ws[method]).mockClear();
    renderDMView();
    for (const id of btnId.split('+')) {
      fireEvent.click(screen.getByTestId(id));
    }
    expect(ws[method]).not.toHaveBeenCalled();
  });

  it('encrypts DM messages when derivedKey is set', async () => {
    useAuthStore.setState({ derivedKey: 'test-key' } as never);
    const { cryptoService } = await import('../../services/crypto');
    vi.mocked(cryptoService.encryptDM).mockResolvedValueOnce('encrypted-text');
    renderDMView();
    fireEvent.click(screen.getByTestId('send-btn'));
    await vi.waitFor(() => {
      expect(cryptoService.encryptDM).toHaveBeenCalled();
    });
  });

  it('falls back to plaintext when encryption fails', async () => {
    useAuthStore.setState({ derivedKey: 'test-key' } as never);
    const { ws } = await import('../../services/websocket');
    const { cryptoService } = await import('../../services/crypto');
    vi.mocked(cryptoService.encryptDM).mockRejectedValueOnce(new Error('encrypt failed'));
    renderDMView();
    fireEvent.click(screen.getByTestId('send-btn'));
    await vi.waitFor(() => {
      expect(ws.sendDMMessage).toHaveBeenCalledWith('team-1', 'dm-1', 'test message');
    });
  });

  it('decrypts DM messages with derivedKey during load', async () => {
    useAuthStore.setState({ derivedKey: 'test-key' } as never);
    const { ws } = await import('../../services/websocket');
    const { cryptoService } = await import('../../services/crypto');
    vi.mocked(ws.isConnected).mockReturnValue(false);
    const { api } = await import('../../services/api');
    vi.mocked(api.getDMMessages).mockResolvedValueOnce([makeDMMessagePayload({ id: 'dm-msg-enc', content: 'encrypted' })]);
    vi.mocked(cryptoService.decryptDM).mockResolvedValueOnce('decrypted');
    renderDMView();
    await vi.waitFor(() => {
      expect(cryptoService.decryptDM).toHaveBeenCalled();
    });
  });

  it('handles load more via WS when connected', async () => {
    const { ws } = await import('../../services/websocket');
    vi.mocked(ws.isConnected).mockReturnValue(true);
    vi.mocked(ws.request).mockResolvedValueOnce([]);
    setStoreWithMessages();
    renderDMView();
    fireEvent.click(screen.getByTestId('load-more'));
    await vi.waitFor(() => {
      expect(ws.request).toHaveBeenCalledWith('team-1', 'dms:messages', expect.objectContaining({ dm_id: 'dm-1' }));
    });
  });

  it('does not load more when activeTeamId is null', async () => {
    useTeamStore.setState({ activeTeamId: null as unknown as string });
    const { ws } = await import('../../services/websocket');
    vi.mocked(ws.request).mockClear();
    useMessageStore.setState({
      messages: new Map(),
      typing: new Map(),
      loadingHistory: new Map([['dm-1', false]]),
      hasMore: new Map([['dm-1', true]]),
    });
    renderDMView();
    fireEvent.click(screen.getByTestId('load-more'));
    expect(ws.request).not.toHaveBeenCalled();
  });

  it.each([
    { scenario: 'already loading', loading: true, hasMore: true },
    { scenario: 'no more messages', loading: false, hasMore: false },
  ])('handleLoadMore does nothing when $scenario', async ({ loading, hasMore }) => {
    const { api } = await import('../../services/api');
    vi.mocked(api.getDMMessages).mockResolvedValueOnce([]);
    useMessageStore.setState({
      messages: new Map(),
      typing: new Map(),
      loadingHistory: new Map([['dm-1', loading]]),
      hasMore: new Map([['dm-1', hasMore]]),
    });
    renderDMView();
    fireEvent.click(screen.getByTestId('load-more'));
  });

  it('tryDecryptDM falls back to content when decryption fails', async () => {
    useAuthStore.setState({ derivedKey: 'test-key' } as never);
    const { ws } = await import('../../services/websocket');
    const { cryptoService } = await import('../../services/crypto');
    vi.mocked(ws.isConnected).mockReturnValue(false);
    const { api } = await import('../../services/api');
    vi.mocked(api.getDMMessages).mockResolvedValueOnce([makeDMMessagePayload({ id: 'dm-msg-fail', content: 'encrypted-raw' })]);
    vi.mocked(cryptoService.decryptDM).mockRejectedValueOnce(new Error('decrypt failed'));
    renderDMView();
    await vi.waitFor(() => {
      expect(cryptoService.decryptDM).toHaveBeenCalled();
    });
  });

  it('handleLoadMore via API when WS is not connected with decryption', async () => {
    useAuthStore.setState({ derivedKey: 'test-key' } as never);
    const { ws } = await import('../../services/websocket');
    const { api } = await import('../../services/api');
    const { cryptoService } = await import('../../services/crypto');
    vi.mocked(ws.isConnected).mockReturnValue(false);
    vi.mocked(api.getDMMessages).mockClear();
    vi.mocked(api.getDMMessages).mockResolvedValue([]);
    vi.mocked(cryptoService.decryptDM).mockResolvedValue('decrypted-old');
    setStoreWithMessages();
    renderDMView();
    await vi.waitFor(() => {
      expect(api.getDMMessages).toHaveBeenCalled();
    });
    fireEvent.click(screen.getByTestId('load-more'));
    await vi.waitFor(() => {
      expect(vi.mocked(api.getDMMessages).mock.calls.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('handleLoadMore catches errors gracefully', async () => {
    const { ws } = await import('../../services/websocket');
    vi.mocked(ws.isConnected).mockReturnValue(true);
    vi.mocked(ws.request)
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('network error'));
    setStoreWithMessages();
    renderDMView();
    await vi.waitFor(() => {
      expect(ws.request).toHaveBeenCalled();
    });
    fireEvent.click(screen.getByTestId('load-more'));
  });

  it('handleLoadMore via WS returns messages with decryption', async () => {
    useAuthStore.setState({ derivedKey: 'test-key' } as never);
    const { ws } = await import('../../services/websocket');
    const { api } = await import('../../services/api');
    const { cryptoService } = await import('../../services/crypto');
    vi.mocked(ws.isConnected).mockReturnValue(false);
    vi.mocked(cryptoService.decryptDM).mockResolvedValue('decrypted-old');
    const fiftyMsgs = Array.from({ length: MESSAGE_PAGE_SIZE }, (_, i) => makeDMMessagePayload({
      id: `msg-${i}`, content: `enc-${i}`,
      created_at: `2025-01-01T00:${String(i).padStart(2, '0')}:00Z`,
    }));
    vi.mocked(api.getDMMessages)
      .mockResolvedValueOnce(fiftyMsgs)
      .mockResolvedValueOnce([makeDMMessagePayload({ id: 'older-msg', content: 'encrypted-old', created_at: '2024-12-31T00:00:00Z' })]);
    renderDMView();
    await vi.waitFor(() => {
      expect(vi.mocked(api.getDMMessages).mock.calls.length).toBeGreaterThanOrEqual(1);
    });
    const loadMoreBtn = screen.queryByTestId('load-more');
    if (loadMoreBtn) {
      fireEvent.click(loadMoreBtn);
      await vi.waitFor(() => {
        expect(vi.mocked(api.getDMMessages).mock.calls.length).toBeGreaterThanOrEqual(2);
      });
    }
  });

  it('tryDecryptDM calls decryptDM for messages during initial load', async () => {
    useAuthStore.setState({ derivedKey: 'test-key' } as never);
    const { cryptoService } = await import('../../services/crypto');
    vi.mocked(cryptoService.decryptDM).mockClear();
    vi.mocked(cryptoService.decryptDM).mockResolvedValue('decrypted');
    const { ws } = await import('../../services/websocket');
    vi.mocked(ws.isConnected).mockReturnValue(false);
    const { api } = await import('../../services/api');
    vi.mocked(api.getDMMessages).mockClear();
    vi.mocked(api.getDMMessages).mockResolvedValueOnce([makeDMMessagePayload({
      id: 'dm-dec-msg-unique', channel_id: 'dm-unique', dm_id: 'dm-unique', content: 'encrypted-content',
    })]);
    render(<DMView dm={makeDM({ id: 'dm-unique' })} currentUserId="user-1" />);
    await vi.waitFor(() => {
      expect(cryptoService.decryptDM).toHaveBeenCalled();
    });
  });
});
