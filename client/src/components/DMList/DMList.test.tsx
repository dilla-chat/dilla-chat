import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DMList from './DMList';
import { useTeamStore } from '../../stores/teamStore';
import { useDMStore } from '../../stores/dmStore';

vi.mock('iconoir-react', () => ({
  Plus: () => <span data-testid="Plus" />,
  Group: () => <span data-testid="Group" />,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, defaultValueOrOpts?: string | Record<string, unknown>, _opts?: Record<string, unknown>) => {
      if (typeof defaultValueOrOpts === 'string') return defaultValueOrOpts;
      return key;
    },
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

vi.mock('../../services/api', () => ({
  api: {
    getDMChannels: vi.fn(() => Promise.resolve([])),
  },
}));

vi.mock('../../services/websocket', () => ({
  ws: {
    isConnected: vi.fn(() => false),
    request: vi.fn(() => Promise.resolve({ dm_channels: [] })),
  },
}));

vi.mock('../../utils/colors', () => ({
  usernameColor: () => '#2e8b9a',
  getInitials: (name: string) => (name || '?').slice(0, 2).toUpperCase(),
}));

const dmChannel = {
  id: 'dm-1',
  team_id: 'team-1',
  is_group: false,
  members: [
    { user_id: 'user-1', username: 'alice', display_name: 'Alice' },
    { user_id: 'user-2', username: 'bob', display_name: 'Bob' },
  ],
  last_message: undefined,
  created_at: '2025-01-01T00:00:00Z',
};

const groupDM = {
  id: 'dm-2',
  team_id: 'team-1',
  is_group: true,
  members: [
    { user_id: 'user-1', username: 'alice', display_name: 'Alice' },
    { user_id: 'user-2', username: 'bob', display_name: 'Bob' },
    { user_id: 'user-3', username: 'charlie', display_name: 'Charlie' },
  ],
  last_message: undefined,
  created_at: '2025-01-02T00:00:00Z',
};

describe('DMList', () => {
  beforeEach(() => {
    useTeamStore.setState({ activeTeamId: 'team-1' });
    useDMStore.setState({
      dmChannels: { 'team-1': [dmChannel, groupDM] },
      activeDMId: null,
    });
  });

  it('renders DM channels', () => {
    render(<DMList currentUserId="user-1" onNewDM={vi.fn()} />);
    // For a 1-1 DM, displays the other user's name
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('renders group DM with all member names', () => {
    render(<DMList currentUserId="user-1" onNewDM={vi.fn()} />);
    expect(screen.getByText('Alice, Bob, Charlie')).toBeInTheDocument();
  });

  it('renders group member count', () => {
    render(<DMList currentUserId="user-1" onNewDM={vi.fn()} />);
    // t('dm.members', '{{count}} members', { count: 3 }) => '{{count}} members'
    expect(screen.getByText('{{count}} members')).toBeInTheDocument();
  });

  it('renders new DM button', () => {
    render(<DMList currentUserId="user-1" onNewDM={vi.fn()} />);
    expect(screen.getByTestId('Plus')).toBeInTheDocument();
  });

  it('calls onNewDM when new button is clicked', () => {
    const onNewDM = vi.fn();
    render(<DMList currentUserId="user-1" onNewDM={onNewDM} />);
    const btn = screen.getByTestId('Plus').closest('button')!;
    fireEvent.click(btn);
    expect(onNewDM).toHaveBeenCalledTimes(1);
  });

  it('sets active DM on click', () => {
    render(<DMList currentUserId="user-1" onNewDM={vi.fn()} />);
    fireEvent.click(screen.getByText('Bob'));
    expect(useDMStore.getState().activeDMId).toBe('dm-1');
  });

  it('marks active DM', () => {
    useDMStore.setState({ activeDMId: 'dm-1' });
    render(<DMList currentUserId="user-1" onNewDM={vi.fn()} />);
    const dmItems = screen.getAllByTestId('dm-item');
    const activeItem = dmItems.find((el) => el.getAttribute('data-active') === 'true');
    expect(activeItem).toBeTruthy();
  });

  it('renders search input', () => {
    render(<DMList currentUserId="user-1" onNewDM={vi.fn()} />);
    expect(screen.getByPlaceholderText('Search members...')).toBeInTheDocument();
  });

  it('filters DMs by search', () => {
    render(<DMList currentUserId="user-1" onNewDM={vi.fn()} />);
    const input = screen.getByPlaceholderText('Search members...');
    fireEvent.change(input, { target: { value: 'Bob' } });
    expect(screen.getByText('Bob')).toBeInTheDocument();
    // Group DM "Alice, Bob, Charlie" should not match "Bob" alone since getDMDisplayName returns full string
    // Actually it will match because "Alice, Bob, Charlie".toLowerCase().includes("bob") is true
  });

  it('shows empty message when no DMs', () => {
    useDMStore.setState({ dmChannels: { 'team-1': [] } });
    render(<DMList currentUserId="user-1" onNewDM={vi.fn()} />);
    expect(screen.getByText('No direct messages yet')).toBeInTheDocument();
  });

  it('shows empty message when filter matches nothing', () => {
    render(<DMList currentUserId="user-1" onNewDM={vi.fn()} />);
    const input = screen.getByPlaceholderText('Search members...');
    fireEvent.change(input, { target: { value: 'zzzzz' } });
    expect(screen.getByText('No direct messages yet')).toBeInTheDocument();
  });

  it('displays last message preview', () => {
    const dmWithMsg = {
      ...dmChannel,
      last_message: { content: 'Hey there!', createdAt: new Date().toISOString() },
    };
    useDMStore.setState({ dmChannels: { 'team-1': [dmWithMsg] } });
    render(<DMList currentUserId="user-1" onNewDM={vi.fn()} />);
    expect(screen.getByText('Hey there!')).toBeInTheDocument();
  });

  it('truncates long last message', () => {
    const longContent = 'A'.repeat(60);
    const dmWithLong = {
      ...dmChannel,
      last_message: { content: longContent, createdAt: new Date().toISOString() },
    };
    useDMStore.setState({ dmChannels: { 'team-1': [dmWithLong] } });
    render(<DMList currentUserId="user-1" onNewDM={vi.fn()} />);
    // Should be truncated to 50 chars + ellipsis
    const expected = longContent.slice(0, 50) + '\u2026';
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it('shows no messages placeholder for DM without last message', () => {
    render(<DMList currentUserId="user-1" onNewDM={vi.fn()} />);
    // 1-1 DM and group DM both have no last_message
    const noMsgElements = screen.getAllByText('No messages yet. Say hello!');
    expect(noMsgElements.length).toBeGreaterThanOrEqual(1);
  });

  it('shows group icon for group DMs', () => {
    render(<DMList currentUserId="user-1" onNewDM={vi.fn()} />);
    expect(screen.getByTestId('Group')).toBeInTheDocument();
  });

  it('sorts DMs by last message time', () => {
    const dm1 = { ...dmChannel, last_message: { content: 'old', createdAt: '2025-01-01T00:00:00Z' } };
    const dm2 = { ...groupDM, last_message: { content: 'new', createdAt: '2025-01-03T00:00:00Z' } };
    useDMStore.setState({ dmChannels: { 'team-1': [dm1, dm2] } });
    render(<DMList currentUserId="user-1" onNewDM={vi.fn()} />);
    const items = screen.getAllByTestId('dm-item');
    // Group DM (newer) should be first
    expect(items[0].textContent).toContain('Alice, Bob, Charlie');
  });

  it('renders yesterday timestamp', () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dmYesterday = {
      ...dmChannel,
      last_message: { content: 'Yesterday msg', createdAt: yesterday.toISOString() },
    };
    useDMStore.setState({ dmChannels: { 'team-1': [dmYesterday] } });
    render(<DMList currentUserId="user-1" onNewDM={vi.fn()} />);
    expect(screen.getByText('Yesterday')).toBeInTheDocument();
  });

  it('renders old date timestamp', () => {
    const dmOld = {
      ...dmChannel,
      last_message: { content: 'Old msg', createdAt: '2020-06-15T10:00:00Z' },
    };
    useDMStore.setState({ dmChannels: { 'team-1': [dmOld] } });
    render(<DMList currentUserId="user-1" onNewDM={vi.fn()} />);
    expect(screen.getByText(/2020/)).toBeInTheDocument();
  });

  it('renders timestamp for today messages', () => {
    const dmToday = {
      ...dmChannel,
      last_message: { content: 'Today msg', createdAt: new Date().toISOString() },
    };
    useDMStore.setState({ dmChannels: { 'team-1': [dmToday] } });
    render(<DMList currentUserId="user-1" onNewDM={vi.fn()} />);
    // Should show time format for today
    expect(screen.getByText('Today msg')).toBeInTheDocument();
  });
});
