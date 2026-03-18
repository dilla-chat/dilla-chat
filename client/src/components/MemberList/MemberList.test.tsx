import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MemberList from './MemberList';
import { useTeamStore } from '../../stores/teamStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { useAuthStore } from '../../stores/authStore';

// Override the global i18n mock to handle interpolation objects
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, defaultValueOrOpts?: string | Record<string, unknown>) => {
      if (typeof defaultValueOrOpts === 'string') return defaultValueOrOpts;
      return key;
    },
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

vi.mock('../../services/api', () => ({
  api: {
    createDM: vi.fn(() => Promise.resolve({ id: 'dm-1' })),
  },
}));

vi.mock('../PresenceIndicator/PresenceIndicator', () => ({
  default: ({ status }: { status: string }) => <span data-testid="presence" data-status={status} />,
}));

vi.mock('../UserProfile/UserProfile', () => ({
  default: ({ member, onSendMessage, onClose }: { member: { username: string }; onSendMessage?: () => void; onClose: () => void }) => (
    <div data-testid="user-profile">
      {member.username}
      {onSendMessage && <button onClick={onSendMessage}>Send</button>}
      <button onClick={onClose}>Close</button>
    </div>
  ),
}));

const makeMember = (id: string, username: string, displayName: string) => ({
  id: `member-${id}`,
  userId: `user-${id}`,
  username,
  displayName,
  nickname: '',
  roles: [],
  statusType: 'online',
});

describe('MemberList', () => {
  beforeEach(() => {
    const members = new Map([
      ['team-1', [
        makeMember('1', 'alice', 'Alice'),
        makeMember('2', 'bob', 'Bob'),
        makeMember('3', 'charlie', 'Charlie'),
      ]],
    ]);
    useTeamStore.setState({ activeTeamId: 'team-1', members });

    usePresenceStore.setState({
      presences: {
        'team-1': {
          'user-1': { user_id: 'user-1', status: 'online', custom_status: '', last_active: '' },
          'user-2': { user_id: 'user-2', status: 'idle', custom_status: 'Working', last_active: '' },
          'user-3': { user_id: 'user-3', status: 'offline', custom_status: '', last_active: '' },
        },
      },
    });

    const teams = new Map([['team-1', { token: 't', user: { id: 'user-1' }, teamInfo: null, baseUrl: '' }]]);
    useAuthStore.setState({ teams });
  });

  it('renders online and offline groups', () => {
    render(<MemberList />);
    // alice=online, bob=idle => online group
    // charlie=offline => offline group
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('Charlie')).toBeInTheDocument();
  });

  it('renders online count header', () => {
    render(<MemberList />);
    // 2 online (alice + bob)
    expect(screen.getByText('presence.onlineCount')).toBeInTheDocument();
  });

  it('renders offline count header', () => {
    render(<MemberList />);
    expect(screen.getByText('presence.offlineCount')).toBeInTheDocument();
  });

  it('renders custom status for members who have one', () => {
    render(<MemberList />);
    expect(screen.getByText('Working')).toBeInTheDocument();
  });

  it('renders presence indicators for each member', () => {
    render(<MemberList />);
    const indicators = screen.getAllByTestId('presence');
    expect(indicators.length).toBe(3);
  });

  it('shows member initials', () => {
    const { container } = render(<MemberList />);
    const avatars = container.querySelectorAll('.member-avatar');
    // Alice => "A", Bob => "B", Charlie => "C"
    const initials = Array.from(avatars).map((a) => a.textContent?.trim());
    expect(initials).toContain('A');
    expect(initials).toContain('B');
    expect(initials).toContain('C');
  });

  it('applies offline class to offline members', () => {
    const { container } = render(<MemberList />);
    const offlineItems = container.querySelectorAll('.member-item.offline');
    expect(offlineItems.length).toBe(1);
  });

  it('renders empty when no team is active', () => {
    useTeamStore.setState({ activeTeamId: null });
    const { container } = render(<MemberList />);
    expect(container.querySelectorAll('.member-item').length).toBe(0);
  });

  it('shows user profile popup on member click', () => {
    render(<MemberList />);
    fireEvent.click(screen.getByText('Alice'));
    expect(screen.getByTestId('user-profile')).toBeInTheDocument();
  });
});
