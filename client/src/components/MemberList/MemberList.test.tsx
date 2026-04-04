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
    render(<MemberList />);
    const avatars = screen.getAllByTestId('member-avatar');
    // Alice => "A", Bob => "B", Charlie => "C"
    const initials = Array.from(avatars).map((a) => a.textContent?.trim());
    expect(initials).toContain('A');
    expect(initials).toContain('B');
    expect(initials).toContain('C');
  });

  it('applies offline attribute to offline members', () => {
    render(<MemberList />);
    const items = screen.getAllByTestId('member-item');
    const offlineItems = items.filter((el) => el.getAttribute('data-offline') === 'true');
    expect(offlineItems.length).toBe(1);
  });

  it('renders empty when no team is active', () => {
    useTeamStore.setState({ activeTeamId: null });
    render(<MemberList />);
    expect(screen.queryAllByTestId('member-item').length).toBe(0);
  });

  it('shows user profile popup on member click', () => {
    render(<MemberList />);
    fireEvent.click(screen.getByText('Alice'));
    expect(screen.getByTestId('user-profile')).toBeInTheDocument();
  });

  it('closes popup on close button click', () => {
    render(<MemberList />);
    fireEvent.click(screen.getByText('Alice'));
    expect(screen.getByTestId('user-profile')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Close'));
    expect(screen.queryByTestId('user-profile')).not.toBeInTheDocument();
  });

  it('shows Send button in popup for other users', () => {
    render(<MemberList />);
    fireEvent.click(screen.getByText('Bob'));
    expect(screen.getByText('Send')).toBeInTheDocument();
  });

  it('does not show Send button for own profile', () => {
    render(<MemberList />);
    fireEvent.click(screen.getByText('Alice'));
    // Current user is user-1 (Alice), so no Send button
    expect(screen.queryByText('Send')).not.toBeInTheDocument();
  });

  it('sorts online members by status priority', () => {
    render(<MemberList />);
    const memberItems = screen.getAllByTestId('member-item');
    const onlineItems = memberItems.filter((el) => el.getAttribute('data-offline') !== 'true');
    const names = onlineItems.map(el => {
      const nameEl = el.querySelector('[data-testid="member-display-name"]');
      return nameEl?.textContent;
    });
    // alice=online, bob=idle => alice before bob
    expect(names[0]).toBe('Alice');
    expect(names[1]).toBe('Bob');
  });

  it('renders nickname when available', () => {
    const members = new Map([
      ['team-1', [
        { id: 'member-1', userId: 'user-1', username: 'alice', displayName: 'Alice', nickname: 'Ali', roles: [], statusType: 'online' },
      ]],
    ]);
    useTeamStore.setState({ activeTeamId: 'team-1', members });
    render(<MemberList />);
    expect(screen.getByText('Ali')).toBeInTheDocument();
  });

  it('sends DM when Send button is clicked in popup', async () => {
    const { api } = await import('../../services/api');
    render(<MemberList />);
    fireEvent.click(screen.getByText('Bob'));
    expect(screen.getByText('Send')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Send'));
    await vi.waitFor(() => {
      expect(api.createDM).toHaveBeenCalledWith('team-1', ['user-2']);
    });
  });

  it('does not send DM when activeTeamId is null', async () => {
    useTeamStore.setState({ activeTeamId: null });
    const { api } = await import('../../services/api');
    vi.mocked(api.createDM).mockClear();
    render(<MemberList />);
    // No popup can be opened, but verify no crash
    expect(screen.queryByTestId('user-profile')).not.toBeInTheDocument();
  });

  it('sorts members alphabetically within same priority', () => {
    const members = new Map([
      ['team-1', [
        makeMember('1', 'zebra', 'Zebra'),
        makeMember('2', 'apple', 'Apple'),
      ]],
    ]);
    useTeamStore.setState({ activeTeamId: 'team-1', members });
    usePresenceStore.setState({
      presences: {
        'team-1': {
          'user-1': { user_id: 'user-1', status: 'online', custom_status: '', last_active: '' },
          'user-2': { user_id: 'user-2', status: 'online', custom_status: '', last_active: '' },
        },
      },
    });
    render(<MemberList />);
    const names = screen.getAllByTestId('member-display-name').map(el => el.textContent);
    expect(names[0]).toBe('Apple');
    expect(names[1]).toBe('Zebra');
  });

  it('closes popup on document click', () => {
    render(<MemberList />);
    fireEvent.click(screen.getByText('Alice'));
    expect(screen.getByTestId('user-profile')).toBeInTheDocument();
    // Simulate document click
    fireEvent.click(document);
    expect(screen.queryByTestId('user-profile')).not.toBeInTheDocument();
  });

  it('sorts members using username fallback when displayName is empty', () => {
    const members = new Map([
      ['team-1', [
        { id: 'member-1', userId: 'user-1', username: 'zebra', displayName: '', nickname: '', roles: [], statusType: 'online' },
        { id: 'member-2', userId: 'user-2', username: 'apple', displayName: '', nickname: '', roles: [], statusType: 'online' },
        { id: 'member-3', userId: 'user-3', username: 'banana', displayName: '', nickname: '', roles: [], statusType: 'offline' },
        { id: 'member-4', userId: 'user-4', username: 'mango', displayName: '', nickname: '', roles: [], statusType: 'offline' },
      ]],
    ]);
    useTeamStore.setState({ activeTeamId: 'team-1', members });
    usePresenceStore.setState({
      presences: {
        'team-1': {
          'user-1': { user_id: 'user-1', status: 'online', custom_status: '', last_active: '' },
          'user-2': { user_id: 'user-2', status: 'online', custom_status: '', last_active: '' },
          'user-3': { user_id: 'user-3', status: 'offline', custom_status: '', last_active: '' },
          'user-4': { user_id: 'user-4', status: 'offline', custom_status: '', last_active: '' },
        },
      },
    });

    render(<MemberList />);
    const allItems = screen.getAllByTestId('member-item');
    const onlineItems = allItems.filter((el) => el.getAttribute('data-offline') !== 'true');
    const onlineNames = onlineItems.map(el => el.querySelector('[data-testid="member-display-name"]')?.textContent);
    // apple < zebra
    expect(onlineNames[0]).toBe('apple');
    expect(onlineNames[1]).toBe('zebra');

    const offlineItems = allItems.filter((el) => el.getAttribute('data-offline') === 'true');
    const offlineNames = offlineItems.map(el => el.querySelector('[data-testid="member-display-name"]')?.textContent);
    // banana < mango
    expect(offlineNames[0]).toBe('banana');
    expect(offlineNames[1]).toBe('mango');
  });

  it('renders multi-word initials from displayName', () => {
    const members = new Map([
      ['team-1', [
        { id: 'member-1', userId: 'user-1', username: 'jd', displayName: 'John Doe', nickname: '', roles: [], statusType: 'online' },
      ]],
    ]);
    useTeamStore.setState({ activeTeamId: 'team-1', members });
    usePresenceStore.setState({
      presences: {
        'team-1': {
          'user-1': { user_id: 'user-1', status: 'online', custom_status: '', last_active: '' },
        },
      },
    });

    render(<MemberList />);
    const avatarText = screen.getByTestId('member-avatar').textContent?.trim();
    expect(avatarText).toBe('JD');
  });

  it('renders username as display name when displayName and nickname are empty', () => {
    const members = new Map([
      ['team-1', [
        { id: 'member-1', userId: 'user-1', username: 'fallback_user', displayName: '', nickname: '', roles: [], statusType: 'online' },
      ]],
    ]);
    useTeamStore.setState({ activeTeamId: 'team-1', members });
    usePresenceStore.setState({
      presences: {
        'team-1': {
          'user-1': { user_id: 'user-1', status: 'online', custom_status: '', last_active: '' },
        },
      },
    });

    render(<MemberList />);
    expect(screen.getByText('fallback_user')).toBeInTheDocument();
  });

  it('falls back to dnd status priority', () => {
    const members = new Map([
      ['team-1', [
        makeMember('1', 'alice', 'Alice'),
        makeMember('2', 'bob', 'Bob'),
      ]],
    ]);
    useTeamStore.setState({ activeTeamId: 'team-1', members });
    usePresenceStore.setState({
      presences: {
        'team-1': {
          'user-1': { user_id: 'user-1', status: 'dnd', custom_status: '', last_active: '' },
          'user-2': { user_id: 'user-2', status: 'online', custom_status: '', last_active: '' },
        },
      },
    });

    render(<MemberList />);
    const allItems = screen.getAllByTestId('member-item');
    const onlineItems = allItems.filter((el) => el.getAttribute('data-offline') !== 'true');
    const names = onlineItems.map(el => el.querySelector('[data-testid="member-display-name"]')?.textContent);
    // Bob (online=0) before Alice (dnd=2)
    expect(names[0]).toBe('Bob');
    expect(names[1]).toBe('Alice');
  });

  it('handles createDM failure gracefully', async () => {
    const { api } = await import('../../services/api');
    vi.mocked(api.createDM).mockRejectedValueOnce(new Error('Network error'));

    render(<MemberList />);
    fireEvent.click(screen.getByText('Bob'));
    expect(screen.getByText('Send')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Send'));

    // Should not throw
    await vi.waitFor(() => {
      expect(api.createDM).toHaveBeenCalled();
    });
  });
});
