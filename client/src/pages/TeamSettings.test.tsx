import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const mockNavigate = vi.fn();

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('iconoir-react', () => ({
  Xmark: () => <span data-testid="Xmark" />,
}));

vi.mock('../services/api', () => ({
  api: {
    updateTeam: vi.fn().mockResolvedValue({}),
    createRole: vi.fn().mockResolvedValue({ id: 'new-role', name: 'New Role', color: '#8fa3b8', permissions: 0, position: 1, isDefault: false }),
    updateRole: vi.fn().mockResolvedValue({}),
    deleteRole: vi.fn().mockResolvedValue({}),
    kickMember: vi.fn().mockResolvedValue({}),
    banMember: vi.fn().mockResolvedValue({}),
    unbanMember: vi.fn().mockResolvedValue({}),
    updateMember: vi.fn().mockResolvedValue({}),
    listInvites: vi.fn().mockResolvedValue([]),
    createInvite: vi.fn().mockResolvedValue({ invite: { id: 'inv-1', token: 'abc', created_by: 'admin', uses: 0, max_uses: null, expires_at: null } }),
    revokeInvite: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../components/FederationStatus/FederationStatus', () => ({
  default: () => <div data-testid="federation-status">FederationStatus</div>,
}));

vi.mock('../components/SettingsLayout/SettingsLayout', () => ({
  default: ({ children, sections, activeId, onSelect, onClose }: {
    children: React.ReactNode;
    sections: Array<{ label?: string; items: Array<{ id: string; label: string }> }>;
    activeId: string;
    onSelect: (id: string) => void;
    onClose: () => void;
  }) => (
    <div data-testid="settings-layout">
      <nav data-testid="settings-nav">
        {sections.flatMap((s) =>
          s.items.map((item) => (
            <button
              key={item.id}
              data-testid={`nav-${item.id}`}
              onClick={() => onSelect(item.id)}
            >
              {item.label}
            </button>
          )),
        )}
      </nav>
      <button data-testid="close-btn" onClick={onClose}>Close</button>
      <div data-testid="settings-content">{children}</div>
    </div>
  ),
}));

vi.mock('../components/TitleBar/TitleBar', () => ({
  default: () => <div data-testid="title-bar">TitleBar</div>,
}));

import TeamSettings from './TeamSettings';
import { useTeamStore, type Team, type Role, type Member } from '../stores/teamStore';

const testTeam: Team = {
  id: 'team1',
  name: 'Test Team',
  description: 'A test team',
  iconUrl: '',
  maxFileSize: 10485760,
  allowMemberInvites: true,
};

const testRoles: Role[] = [
  { id: 'role-admin', name: 'Admin', color: '#ff0000', position: 2, permissions: 0x1, isDefault: false },
  { id: 'role-member', name: 'Member', color: '#8fa3b8', position: 0, permissions: 0x20, isDefault: true },
];

const testMembers: Member[] = [
  { id: 'm1', userId: 'u1', username: 'alice', displayName: 'Alice', nickname: '', roles: [testRoles[0]], statusType: 'online' },
  { id: 'm2', userId: 'u2', username: 'bob', displayName: 'Bob', nickname: 'Bobby', roles: [testRoles[1]], statusType: 'offline' },
];

describe('TeamSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigate.mockClear();
    useTeamStore.setState({
      activeTeamId: 'team1',
      teams: new Map([['team1', testTeam]]),
      channels: new Map(),
      members: new Map([['team1', testMembers]]),
      roles: new Map([['team1', testRoles]]),
      setTeam: vi.fn(),
      setMembers: vi.fn(),
      setRoles: vi.fn(),
    });
  });

  it('renders team settings in SettingsLayout', () => {
    render(<TeamSettings />);
    expect(screen.getByTestId('settings-layout')).toBeInTheDocument();
  });

  it('shows overview tab by default with team name input', () => {
    render(<TeamSettings />);
    // The overview tab content includes the team name input
    expect(screen.getByDisplayValue('Test Team')).toBeInTheDocument();
  });

  it('renders team name input in overview', () => {
    render(<TeamSettings />);
    expect(screen.getByDisplayValue('Test Team')).toBeInTheDocument();
  });

  it('renders description textarea in overview', () => {
    render(<TeamSettings />);
    expect(screen.getByDisplayValue('A test team')).toBeInTheDocument();
  });

  it('renders save button in overview', () => {
    render(<TeamSettings />);
    expect(screen.getByText('Save Changes')).toBeInTheDocument();
  });

  it('renders allow invites toggle', () => {
    render(<TeamSettings />);
    expect(screen.getByText('Allow Member Invites')).toBeInTheDocument();
  });

  it('renders team name label', () => {
    render(<TeamSettings />);
    expect(screen.getByText('Team Name')).toBeInTheDocument();
  });

  it('renders description label', () => {
    render(<TeamSettings />);
    expect(screen.getByText('Description')).toBeInTheDocument();
  });

  it('navigates to /app on close', () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByTestId('close-btn'));
    expect(mockNavigate).toHaveBeenCalledWith('/app');
  });

  it('switches to roles tab and shows roles list', () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByTestId('nav-roles'));

    expect(screen.getByText('Admin')).toBeInTheDocument();
    // Member role also visible
    const memberTexts = screen.getAllByText('Member');
    expect(memberTexts.length).toBeGreaterThanOrEqual(1);
  });

  it('shows create role button in roles tab', () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByTestId('nav-roles'));

    expect(screen.getByText('Create Role')).toBeInTheDocument();
  });

  it('shows default badge for default role', () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByTestId('nav-roles'));

    expect(screen.getByText('Default')).toBeInTheDocument();
  });

  it('shows role editor when a role is clicked', () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByTestId('nav-roles'));
    fireEvent.click(screen.getByText('Admin'));

    expect(screen.getByDisplayValue('Admin')).toBeInTheDocument();
    expect(screen.getByText('Permissions')).toBeInTheDocument();
  });

  it('switches to members tab and shows member list', () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByTestId('nav-members'));

    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('shows member search input', () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByTestId('nav-members'));

    expect(screen.getByPlaceholderText('Search members...')).toBeInTheDocument();
  });

  it('filters members by search', () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByTestId('nav-members'));

    fireEvent.change(screen.getByPlaceholderText('Search members...'), {
      target: { value: 'alice' },
    });

    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.queryByText('Bob')).not.toBeInTheDocument();
  });

  it('shows kick and ban buttons when member is selected', () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByTestId('nav-members'));

    fireEvent.click(screen.getByText('Alice'));

    expect(screen.getByText('Kick')).toBeInTheDocument();
    expect(screen.getByText('Ban')).toBeInTheDocument();
  });

  it('switches to invites tab', () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByTestId('nav-invites'));

    expect(screen.getByText('Create Invite')).toBeInTheDocument();
  });

  it('switches to federation tab', () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByTestId('nav-federation'));

    expect(screen.getByTestId('federation-status')).toBeInTheDocument();
  });

  it('shows moderation tab content', () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByTestId('nav-moderation'));

    expect(screen.getByText('Configure moderation tools and auto-moderation rules.')).toBeInTheDocument();
  });

  it('shows audit log tab content', () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByTestId('nav-audit-log'));

    expect(screen.getByText('No recent actions')).toBeInTheDocument();
  });

  it('shows bans tab content', () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByTestId('nav-bans'));

    expect(screen.getByText('No banned users')).toBeInTheDocument();
  });

  it('shows delete server tab content', () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByTestId('nav-delete-server'));

    expect(screen.getByText('This action is irreversible. All data will be permanently deleted.')).toBeInTheDocument();
  });

  it('shows permission checkboxes in role editor', () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByTestId('nav-roles'));
    fireEvent.click(screen.getByText('Admin'));

    expect(screen.getByText('permissions.admin')).toBeInTheDocument();
    expect(screen.getByText('permissions.manageChannels')).toBeInTheDocument();
    expect(screen.getByText('permissions.sendMessages')).toBeInTheDocument();
  });

  it('shows member usernames with @ prefix', () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByTestId('nav-members'));

    expect(screen.getByText('@alice')).toBeInTheDocument();
    expect(screen.getByText('@bob')).toBeInTheDocument();
  });

  it('shows role tags on members', () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByTestId('nav-members'));

    const adminTags = screen.getAllByText('Admin');
    expect(adminTags.length).toBeGreaterThan(0);
  });

  it('renders all nav items', () => {
    render(<TeamSettings />);
    expect(screen.getByTestId('nav-overview')).toBeInTheDocument();
    expect(screen.getByTestId('nav-roles')).toBeInTheDocument();
    expect(screen.getByTestId('nav-members')).toBeInTheDocument();
    expect(screen.getByTestId('nav-invites')).toBeInTheDocument();
    expect(screen.getByTestId('nav-moderation')).toBeInTheDocument();
    expect(screen.getByTestId('nav-audit-log')).toBeInTheDocument();
    expect(screen.getByTestId('nav-bans')).toBeInTheDocument();
    expect(screen.getByTestId('nav-federation')).toBeInTheDocument();
    expect(screen.getByTestId('nav-delete-server')).toBeInTheDocument();
  });
});
