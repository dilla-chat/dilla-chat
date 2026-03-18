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
    t: (key: string, defaultValueOrOpts?: string | Record<string, unknown>, opts?: Record<string, unknown>) => {
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
    const { container } = render(<DMList currentUserId="user-1" onNewDM={vi.fn()} />);
    expect(container.querySelector('.dm-item.active')).toBeInTheDocument();
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
});
