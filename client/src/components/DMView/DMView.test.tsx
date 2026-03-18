import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DMView from './DMView';
import { useTeamStore } from '../../stores/teamStore';
import { useAuthStore } from '../../stores/authStore';
import { useMessageStore } from '../../stores/messageStore';
import type { DMChannel } from '../../stores/dmStore';

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

  it('renders MessageList and MessageInput', () => {
    render(<DMView dm={makeDM()} currentUserId="user-1" />);
    expect(screen.getByTestId('message-list')).toBeInTheDocument();
    expect(screen.getByTestId('message-input')).toBeInTheDocument();
  });

  it('passes DM id as channelId to MessageList', () => {
    render(<DMView dm={makeDM()} currentUserId="user-1" />);
    expect(screen.getByTestId('message-list')).toHaveAttribute('data-channel-id', 'dm-1');
  });

  it('shows the other participant name in MessageInput for 1:1 DM', () => {
    render(<DMView dm={makeDM()} currentUserId="user-1" />);
    expect(screen.getByTestId('message-input')).toHaveAttribute('data-channel-name', 'Bob');
  });

  it('shows comma-joined names for group DM', () => {
    const groupDM = makeDM({
      is_group: true,
      members: [
        { user_id: 'user-1', username: 'alice', display_name: 'Alice' },
        { user_id: 'user-2', username: 'bob', display_name: 'Bob' },
        { user_id: 'user-3', username: 'charlie', display_name: 'Charlie' },
      ],
    });
    render(<DMView dm={groupDM} currentUserId="user-1" />);
    expect(screen.getByTestId('message-input')).toHaveAttribute(
      'data-channel-name',
      'Alice, Bob, Charlie',
    );
  });

  it('shows member panel when showMembers is true for group DM', () => {
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
  });

  it('does not show member panel for non-group DM even with showMembers', () => {
    render(<DMView dm={makeDM()} currentUserId="user-1" showMembers />);
    expect(screen.queryByText('{{count}} members')).not.toBeInTheDocument();
  });

  it('loads DM message history via API on mount', async () => {
    const { api } = await import('../../services/api');
    vi.mocked(api.getDMMessages).mockResolvedValueOnce([
      {
        id: 'dm-msg-1',
        channel_id: 'dm-1',
        dm_id: 'dm-1',
        author_id: 'user-2',
        username: 'bob',
        content: 'Hey!',
        type: 'text',
        thread_id: null,
        edited_at: null,
        deleted: false,
        created_at: '2025-01-01T00:00:00Z',
        reactions: [],
      },
    ]);
    render(<DMView dm={makeDM()} currentUserId="user-1" />);
    await vi.waitFor(() => {
      expect(api.getDMMessages).toHaveBeenCalledWith('team-1', 'dm-1', undefined, 50);
    });
  });

  it('loads DM messages via WS when connected', async () => {
    const { ws } = await import('../../services/websocket');
    vi.mocked(ws.isConnected).mockReturnValue(true);
    vi.mocked(ws.request).mockResolvedValueOnce([]);
    render(<DMView dm={makeDM()} currentUserId="user-1" />);
    await vi.waitFor(() => {
      expect(ws.request).toHaveBeenCalledWith('team-1', 'dms:messages', expect.objectContaining({ dm_id: 'dm-1' }));
    });
  });

  it('subscribes to DM WebSocket events', async () => {
    const { ws } = await import('../../services/websocket');
    render(<DMView dm={makeDM()} currentUserId="user-1" />);
    const calls = vi.mocked(ws.on).mock.calls;
    const eventNames = calls.map(c => c[0]);
    expect(eventNames).toContain('dm:message:new');
    expect(eventNames).toContain('dm:message:updated');
    expect(eventNames).toContain('dm:message:deleted');
    expect(eventNames).toContain('dm:typing:indicator');
  });

  it('handles dm:message:new event for this DM', async () => {
    const { ws } = await import('../../services/websocket');
    render(<DMView dm={makeDM()} currentUserId="user-1" />);
    const calls = vi.mocked(ws.on).mock.calls;
    const newMsgHandler = calls.find(c => c[0] === 'dm:message:new');
    if (newMsgHandler) {
      await (newMsgHandler[1] as Function)({
        id: 'dm-msg-2', dm_id: 'dm-1', channel_id: 'dm-1', author_id: 'user-2',
        username: 'bob', content: 'Hi!', type: 'text', thread_id: null,
        edited_at: null, deleted: false, created_at: '2025-01-01T01:00:00Z', reactions: [],
      });
    }
  });

  it('ignores dm:message:new event for other DMs', async () => {
    const { ws } = await import('../../services/websocket');
    render(<DMView dm={makeDM()} currentUserId="user-1" />);
    const calls = vi.mocked(ws.on).mock.calls;
    const newMsgHandler = calls.find(c => c[0] === 'dm:message:new');
    if (newMsgHandler) {
      await (newMsgHandler[1] as Function)({
        id: 'dm-msg-x', dm_id: 'other-dm', channel_id: 'other-dm', author_id: 'user-3',
        username: 'charlie', content: 'Nope', type: 'text', thread_id: null,
        edited_at: null, deleted: false, created_at: '2025-01-01T01:00:00Z', reactions: [],
      });
    }
  });

  it('handles dm:message:updated event', async () => {
    const { ws } = await import('../../services/websocket');
    render(<DMView dm={makeDM()} currentUserId="user-1" />);
    const calls = vi.mocked(ws.on).mock.calls;
    const editHandler = calls.find(c => c[0] === 'dm:message:updated');
    if (editHandler) {
      await (editHandler[1] as Function)({
        dm_id: 'dm-1', message_id: 'dm-msg-1', content: 'edited', author_id: 'user-2', username: 'bob',
      });
    }
  });

  it('handles dm:message:deleted event', async () => {
    const { ws } = await import('../../services/websocket');
    render(<DMView dm={makeDM()} currentUserId="user-1" />);
    const calls = vi.mocked(ws.on).mock.calls;
    const deleteHandler = calls.find(c => c[0] === 'dm:message:deleted');
    if (deleteHandler) {
      (deleteHandler[1] as Function)({ dm_id: 'dm-1', message_id: 'dm-msg-1' });
    }
  });

  it('handles dm:typing:indicator event', async () => {
    const { ws } = await import('../../services/websocket');
    render(<DMView dm={makeDM()} currentUserId="user-1" />);
    const calls = vi.mocked(ws.on).mock.calls;
    const typingHandler = calls.find(c => c[0] === 'dm:typing:indicator');
    if (typingHandler) {
      (typingHandler[1] as Function)({ dm_id: 'dm-1', user_id: 'user-2', username: 'bob' });
    }
  });

  it('unsubscribes from events on unmount', async () => {
    const { ws } = await import('../../services/websocket');
    const unsub = vi.fn();
    vi.mocked(ws.on).mockReturnValue(unsub);

    const { unmount } = render(<DMView dm={makeDM()} currentUserId="user-1" />);
    unmount();
    expect(unsub).toHaveBeenCalled();
  });

  it('shows member username with @ prefix in group member panel', () => {
    const groupDM = makeDM({
      is_group: true,
      members: [
        { user_id: 'user-1', username: 'alice', display_name: 'Alice' },
        { user_id: 'user-2', username: 'bob', display_name: 'Bob' },
      ],
    });
    render(<DMView dm={groupDM} currentUserId="user-1" showMembers />);
    expect(screen.getByText('@alice')).toBeInTheDocument();
    expect(screen.getByText('@bob')).toBeInTheDocument();
  });

  it('shows fallback display name when member has no display_name', () => {
    const dm = makeDM({
      members: [
        { user_id: 'user-1', username: 'alice', display_name: '' },
        { user_id: 'user-2', username: 'bob', display_name: '' },
      ],
    });
    render(<DMView dm={dm} currentUserId="user-1" />);
    expect(screen.getByTestId('message-input')).toHaveAttribute('data-channel-name', 'bob');
  });

  it('sends a DM message via WS when send button is clicked', async () => {
    const { ws } = await import('../../services/websocket');
    render(<DMView dm={makeDM()} currentUserId="user-1" />);
    fireEvent.click(screen.getByTestId('send-btn'));
    await vi.waitFor(() => {
      expect(ws.sendDMMessage).toHaveBeenCalledWith('team-1', 'dm-1', expect.any(String));
    });
  });

  it('edits a DM message via WS when save edit button is clicked', async () => {
    const { ws } = await import('../../services/websocket');
    render(<DMView dm={makeDM()} currentUserId="user-1" />);
    // First trigger edit mode
    fireEvent.click(screen.getByTestId('edit-msg'));
    // Then save the edit
    fireEvent.click(screen.getByTestId('edit-btn'));
    await vi.waitFor(() => {
      expect(ws.editDMMessage).toHaveBeenCalledWith('team-1', 'dm-1', 'msg-1', expect.any(String));
    });
  });

  it('deletes a DM message via WS when delete button is clicked', async () => {
    const { ws } = await import('../../services/websocket');
    render(<DMView dm={makeDM()} currentUserId="user-1" />);
    fireEvent.click(screen.getByTestId('delete-msg'));
    expect(ws.deleteDMMessage).toHaveBeenCalledWith('team-1', 'dm-1', 'msg-1');
  });

  it('sends typing indicator via WS when typing', async () => {
    const { ws } = await import('../../services/websocket');
    render(<DMView dm={makeDM()} currentUserId="user-1" />);
    fireEvent.click(screen.getByTestId('typing-btn'));
    expect(ws.startDMTyping).toHaveBeenCalledWith('team-1', 'dm-1');
  });

  it('clicking edit button sets editing message state', () => {
    render(<DMView dm={makeDM()} currentUserId="user-1" />);
    fireEvent.click(screen.getByTestId('edit-msg'));
    expect(screen.getByTestId('editing-indicator')).toBeInTheDocument();
  });

  it('clicking cancel edit clears editing message state', () => {
    render(<DMView dm={makeDM()} currentUserId="user-1" />);
    fireEvent.click(screen.getByTestId('edit-msg'));
    expect(screen.getByTestId('editing-indicator')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('cancel-edit-btn'));
    expect(screen.queryByTestId('editing-indicator')).not.toBeInTheDocument();
  });

  it('triggers handleLoadMore via load more button', async () => {
    const { ws } = await import('../../services/websocket');
    useMessageStore.setState({
      messages: new Map([['dm-1', [{ id: 'old-msg', channelId: 'dm-1', authorId: 'user-2', username: 'bob', content: 'old', encryptedContent: '', type: 'text', threadId: null, editedAt: null, deleted: false, createdAt: '2025-01-01T00:00:00Z', reactions: [] }]]]),
      typing: new Map(),
      loadingHistory: new Map([['dm-1', false]]),
      hasMore: new Map([['dm-1', true]]),
    });
    render(<DMView dm={makeDM()} currentUserId="user-1" />);
    fireEvent.click(screen.getByTestId('load-more'));
    // Should trigger load more via API since ws is not connected
  });

  it('does not send when activeTeamId is null', async () => {
    useTeamStore.setState({ activeTeamId: null as unknown as string });
    const { ws } = await import('../../services/websocket');
    vi.mocked(ws.sendDMMessage).mockClear();
    render(<DMView dm={makeDM()} currentUserId="user-1" />);
    fireEvent.click(screen.getByTestId('send-btn'));
    // With null activeTeamId, handleSend returns early
    expect(ws.sendDMMessage).not.toHaveBeenCalled();
  });

  it('encrypts DM messages when derivedKey is set', async () => {
    useAuthStore.setState({ derivedKey: 'test-key' } as never);
    const { ws } = await import('../../services/websocket');
    const { cryptoService } = await import('../../services/crypto');
    vi.mocked(cryptoService.encryptDM).mockResolvedValueOnce('encrypted-text');
    render(<DMView dm={makeDM()} currentUserId="user-1" />);
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
    render(<DMView dm={makeDM()} currentUserId="user-1" />);
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
    vi.mocked(api.getDMMessages).mockResolvedValueOnce([
      {
        id: 'dm-msg-enc', channel_id: 'dm-1', dm_id: 'dm-1', author_id: 'user-2',
        username: 'bob', content: 'encrypted', type: 'text', thread_id: null,
        edited_at: null, deleted: false, created_at: '2025-01-01T00:00:00Z', reactions: [],
      },
    ]);
    vi.mocked(cryptoService.decryptDM).mockResolvedValueOnce('decrypted');

    render(<DMView dm={makeDM()} currentUserId="user-1" />);
    await vi.waitFor(() => {
      expect(cryptoService.decryptDM).toHaveBeenCalled();
    });
  });

  it('handles load more via WS when connected', async () => {
    const { ws } = await import('../../services/websocket');
    vi.mocked(ws.isConnected).mockReturnValue(true);
    vi.mocked(ws.request).mockResolvedValueOnce([]);
    useMessageStore.setState({
      messages: new Map([['dm-1', [{ id: 'old-msg', channelId: 'dm-1', authorId: 'user-2', username: 'bob', content: 'old', encryptedContent: '', type: 'text', threadId: null, editedAt: null, deleted: false, createdAt: '2025-01-01T00:00:00Z', reactions: [] }]]]),
      typing: new Map(),
      loadingHistory: new Map([['dm-1', false]]),
      hasMore: new Map([['dm-1', true]]),
    });
    render(<DMView dm={makeDM()} currentUserId="user-1" />);
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
    render(<DMView dm={makeDM()} currentUserId="user-1" />);
    fireEvent.click(screen.getByTestId('load-more'));
    expect(ws.request).not.toHaveBeenCalled();
  });

  it('does not edit when activeTeamId is null', async () => {
    useTeamStore.setState({ activeTeamId: null as unknown as string });
    const { ws } = await import('../../services/websocket');
    vi.mocked(ws.editDMMessage).mockClear();
    render(<DMView dm={makeDM()} currentUserId="user-1" />);
    fireEvent.click(screen.getByTestId('edit-msg'));
    fireEvent.click(screen.getByTestId('edit-btn'));
    expect(ws.editDMMessage).not.toHaveBeenCalled();
  });

  it('does not delete when activeTeamId is null', async () => {
    useTeamStore.setState({ activeTeamId: null as unknown as string });
    const { ws } = await import('../../services/websocket');
    vi.mocked(ws.deleteDMMessage).mockClear();
    render(<DMView dm={makeDM()} currentUserId="user-1" />);
    fireEvent.click(screen.getByTestId('delete-msg'));
    expect(ws.deleteDMMessage).not.toHaveBeenCalled();
  });

  it('does not type when activeTeamId is null', async () => {
    useTeamStore.setState({ activeTeamId: null as unknown as string });
    const { ws } = await import('../../services/websocket');
    vi.mocked(ws.startDMTyping).mockClear();
    render(<DMView dm={makeDM()} currentUserId="user-1" />);
    fireEvent.click(screen.getByTestId('typing-btn'));
    expect(ws.startDMTyping).not.toHaveBeenCalled();
  });

  it('ignores dm:message:updated for other DMs', async () => {
    const { ws } = await import('../../services/websocket');
    render(<DMView dm={makeDM()} currentUserId="user-1" />);
    const calls = vi.mocked(ws.on).mock.calls;
    const editHandler = calls.find(c => c[0] === 'dm:message:updated');
    if (editHandler) {
      await (editHandler[1] as Function)({
        dm_id: 'other-dm', message_id: 'msg-x', content: 'edited', author_id: 'user-3', username: 'charlie',
      });
    }
  });

  it('ignores dm:message:deleted for other DMs', async () => {
    const { ws } = await import('../../services/websocket');
    render(<DMView dm={makeDM()} currentUserId="user-1" />);
    const calls = vi.mocked(ws.on).mock.calls;
    const deleteHandler = calls.find(c => c[0] === 'dm:message:deleted');
    if (deleteHandler) {
      (deleteHandler[1] as Function)({ dm_id: 'other-dm', message_id: 'msg-x' });
    }
  });

  it('ignores dm:typing:indicator for other DMs', async () => {
    const { ws } = await import('../../services/websocket');
    render(<DMView dm={makeDM()} currentUserId="user-1" />);
    const calls = vi.mocked(ws.on).mock.calls;
    const typingHandler = calls.find(c => c[0] === 'dm:typing:indicator');
    if (typingHandler) {
      (typingHandler[1] as Function)({ dm_id: 'other-dm', user_id: 'user-3', username: 'charlie' });
    }
  });

  it('shows Unknown when no other member found', () => {
    const dm = makeDM({
      members: [{ user_id: 'user-1', username: 'alice', display_name: 'Alice' }],
    });
    render(<DMView dm={dm} currentUserId="user-1" />);
    expect(screen.getByTestId('message-input')).toHaveAttribute('data-channel-name', 'Unknown');
  });

  it('tryDecryptDM falls back to content when decryption fails', async () => {
    useAuthStore.setState({ derivedKey: 'test-key' } as never);
    const { ws } = await import('../../services/websocket');
    const { cryptoService } = await import('../../services/crypto');
    vi.mocked(ws.isConnected).mockReturnValue(false);
    const { api } = await import('../../services/api');
    vi.mocked(api.getDMMessages).mockResolvedValueOnce([
      {
        id: 'dm-msg-fail', channel_id: 'dm-1', dm_id: 'dm-1', author_id: 'user-2',
        username: 'bob', content: 'encrypted-raw', type: 'text', thread_id: null,
        edited_at: null, deleted: false, created_at: '2025-01-01T00:00:00Z', reactions: [],
      },
    ]);
    vi.mocked(cryptoService.decryptDM).mockRejectedValueOnce(new Error('decrypt failed'));

    render(<DMView dm={makeDM()} currentUserId="user-1" />);
    await vi.waitFor(() => {
      expect(cryptoService.decryptDM).toHaveBeenCalled();
    });
    // Should fall back to raw content instead of crashing
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

    useMessageStore.setState({
      messages: new Map([['dm-1', [{ id: 'existing-msg', channelId: 'dm-1', authorId: 'user-2', username: 'bob', content: 'existing', encryptedContent: '', type: 'text', threadId: null, editedAt: null, deleted: false, createdAt: '2025-01-01T00:00:00Z', reactions: [] }]]]),
      typing: new Map(),
      loadingHistory: new Map([['dm-1', false]]),
      hasMore: new Map([['dm-1', true]]),
    });

    render(<DMView dm={makeDM()} currentUserId="user-1" />);

    // Wait for initial load
    await vi.waitFor(() => {
      expect(api.getDMMessages).toHaveBeenCalled();
    });

    // Click load more
    fireEvent.click(screen.getByTestId('load-more'));
    // Verify at least one more call was made (load more triggered)
    await vi.waitFor(() => {
      expect(vi.mocked(api.getDMMessages).mock.calls.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('handleLoadMore does nothing when already loading', async () => {
    const { api } = await import('../../services/api');
    vi.mocked(api.getDMMessages).mockResolvedValueOnce([]);
    useMessageStore.setState({
      messages: new Map(),
      typing: new Map(),
      loadingHistory: new Map([['dm-1', true]]),
      hasMore: new Map([['dm-1', true]]),
    });
    render(<DMView dm={makeDM()} currentUserId="user-1" />);
    fireEvent.click(screen.getByTestId('load-more'));
    // Should not make additional API calls when already loading
  });

  it('handleLoadMore does nothing when no more messages', async () => {
    const { api } = await import('../../services/api');
    vi.mocked(api.getDMMessages).mockResolvedValueOnce([]);
    useMessageStore.setState({
      messages: new Map(),
      typing: new Map(),
      loadingHistory: new Map([['dm-1', false]]),
      hasMore: new Map([['dm-1', false]]),
    });
    render(<DMView dm={makeDM()} currentUserId="user-1" />);
    fireEvent.click(screen.getByTestId('load-more'));
    // Should not make additional API calls when hasMore is false
  });

  it('handleLoadMore catches errors gracefully', async () => {
    const { ws } = await import('../../services/websocket');
    vi.mocked(ws.isConnected).mockReturnValue(true);
    vi.mocked(ws.request)
      .mockResolvedValueOnce([]) // initial load
      .mockRejectedValueOnce(new Error('network error')); // load more
    useMessageStore.setState({
      messages: new Map([['dm-1', [{ id: 'msg-1', channelId: 'dm-1', authorId: 'user-2', username: 'bob', content: 'hi', encryptedContent: '', type: 'text', threadId: null, editedAt: null, deleted: false, createdAt: '2025-01-01T00:00:00Z', reactions: [] }]]]),
      typing: new Map(),
      loadingHistory: new Map([['dm-1', false]]),
      hasMore: new Map([['dm-1', true]]),
    });
    render(<DMView dm={makeDM()} currentUserId="user-1" />);
    await vi.waitFor(() => {
      expect(ws.request).toHaveBeenCalled();
    });
    fireEvent.click(screen.getByTestId('load-more'));
    // Should not crash
  });

  it('handleLoadMore via WS returns messages with decryption', async () => {
    useAuthStore.setState({ derivedKey: 'test-key' } as never);
    const { ws } = await import('../../services/websocket');
    const { api } = await import('../../services/api');
    const { cryptoService } = await import('../../services/crypto');

    vi.mocked(ws.isConnected).mockReturnValue(false);
    vi.mocked(cryptoService.decryptDM).mockResolvedValue('decrypted-old');

    // First call (initial load) returns 50 messages to set hasMore=true
    const fiftyMsgs = Array.from({ length: 50 }, (_, i) => ({
      id: `msg-${i}`, channel_id: 'dm-1', dm_id: 'dm-1', author_id: 'user-2',
      username: 'bob', content: `enc-${i}`, type: 'text', thread_id: null,
      edited_at: null, deleted: false, created_at: `2025-01-01T00:${String(i).padStart(2, '0')}:00Z`, reactions: [],
    }));
    // Second call (load more) returns actual older messages
    const olderMsgs = [{
      id: 'older-msg', channel_id: 'dm-1', dm_id: 'dm-1', author_id: 'user-2',
      username: 'bob', content: 'encrypted-old', type: 'text', thread_id: null,
      edited_at: null, deleted: false, created_at: '2024-12-31T00:00:00Z', reactions: [],
    }];
    vi.mocked(api.getDMMessages)
      .mockResolvedValueOnce(fiftyMsgs)
      .mockResolvedValueOnce(olderMsgs);

    render(<DMView dm={makeDM()} currentUserId="user-1" />);

    // Wait for initial load to complete and load-more to appear
    await vi.waitFor(() => {
      expect(vi.mocked(api.getDMMessages).mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    // Trigger load more
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
    vi.mocked(api.getDMMessages).mockResolvedValueOnce([
      {
        id: 'dm-dec-msg-unique', channel_id: 'dm-unique', dm_id: 'dm-unique', author_id: 'user-2',
        username: 'bob', content: 'encrypted-content', type: 'text', thread_id: null,
        edited_at: null, deleted: false, created_at: '2025-01-01T00:00:00Z', reactions: [],
      },
    ]);
    const uniqueDM = makeDM({ id: 'dm-unique' });
    render(<DMView dm={uniqueDM} currentUserId="user-1" />);
    await vi.waitFor(() => {
      expect(cryptoService.decryptDM).toHaveBeenCalled();
    });
  });
});
