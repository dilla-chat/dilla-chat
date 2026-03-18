import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

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
  default: ({ channelId, channelName }: { channelId: string; channelName?: string }) => (
    <div data-testid="message-list" data-channel-id={channelId} data-channel-name={channelName}>
      MessageList
    </div>
  ),
}));

vi.mock('../components/MessageInput/MessageInput', () => ({
  default: ({ channelId, channelName }: { channelId: string; channelName?: string }) => (
    <div data-testid="message-input" data-channel-id={channelId} data-channel-name={channelName}>
      MessageInput
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

  // WS history/thread loading tests omitted — require deep async mocking
  // of the component's useEffect data fetching flow
});
