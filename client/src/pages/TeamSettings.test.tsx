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

  // --- Overview Tab ---
  it('renders icon URL and max file size inputs in overview', () => {
    render(<TeamSettings />);
    expect(screen.getByText('Icon URL')).toBeInTheDocument();
    expect(screen.getByText('Max File Size (bytes)')).toBeInTheDocument();
  });

  it('edits team name in overview', () => {
    render(<TeamSettings />);
    const input = screen.getByDisplayValue('Test Team');
    fireEvent.change(input, { target: { value: 'Updated Team' } });
    expect(input).toHaveValue('Updated Team');
  });

  it('edits team description in overview', () => {
    render(<TeamSettings />);
    const textarea = screen.getByDisplayValue('A test team');
    fireEvent.change(textarea, { target: { value: 'New description' } });
    expect(textarea).toHaveValue('New description');
  });

  it('toggles allow member invites', () => {
    render(<TeamSettings />);
    const toggles = screen.getAllByRole('button').filter(b => b.className.includes('toggle-switch'));
    expect(toggles.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(toggles[0]);
  });

  it('saves overview changes on button click', async () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByText('Save Changes'));
    const { api } = await import('../services/api');
    expect(api.updateTeam).toHaveBeenCalledWith('team1', expect.objectContaining({ name: 'Test Team' }));
  });

  // --- Roles Tab ---
  it('creates a new role', async () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByTestId('nav-roles'));
    fireEvent.click(screen.getByText('Create Role'));
    const { api } = await import('../services/api');
    expect(api.createRole).toHaveBeenCalledWith('team1', expect.objectContaining({ name: 'New Role' }));
  });

  it('selects a role and shows editor with name input', () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByTestId('nav-roles'));
    fireEvent.click(screen.getByText('Admin'));
    expect(screen.getByDisplayValue('Admin')).toBeInTheDocument();
  });

  it('edits role name', () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByTestId('nav-roles'));
    fireEvent.click(screen.getByText('Admin'));
    const input = screen.getByDisplayValue('Admin');
    fireEvent.change(input, { target: { value: 'Super Admin' } });
    expect(input).toHaveValue('Super Admin');
  });

  it('toggles permission checkbox', () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByTestId('nav-roles'));
    fireEvent.click(screen.getByText('Admin'));
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes.length).toBeGreaterThan(0);
    fireEvent.click(checkboxes[0]);
  });

  it('saves role changes', async () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByTestId('nav-roles'));
    fireEvent.click(screen.getByText('Admin'));
    fireEvent.click(screen.getByText('Save Changes'));
    const { api } = await import('../services/api');
    expect(api.updateRole).toHaveBeenCalled();
  });

  it('shows delete button for non-default role', () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByTestId('nav-roles'));
    fireEvent.click(screen.getByText('Admin'));
    expect(screen.getByText('Delete Role')).toBeInTheDocument();
  });

  it('does not show delete button for default role', () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByTestId('nav-roles'));
    // Click on the Member role (which is default)
    const memberTexts = screen.getAllByText('Member');
    // Click the one in the roles list (not in nav)
    fireEvent.click(memberTexts[memberTexts.length - 1]);
    expect(screen.queryByText('Delete Role')).not.toBeInTheDocument();
  });

  it('deletes a role', async () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByTestId('nav-roles'));
    fireEvent.click(screen.getByText('Admin'));
    fireEvent.click(screen.getByText('Delete Role'));
    const { api } = await import('../services/api');
    expect(api.deleteRole).toHaveBeenCalledWith('team1', 'role-admin');
  });

  // --- Members Tab ---
  it('shows member initials in avatar', () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByTestId('nav-members'));
    expect(screen.getByText('A')).toBeInTheDocument(); // Alice's initial
  });

  it('filters members by nickname', () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByTestId('nav-members'));
    fireEvent.change(screen.getByPlaceholderText('Search members...'), {
      target: { value: 'Bobby' },
    });
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
  });

  it('toggles member selection (deselects on second click)', () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByTestId('nav-members'));
    const aliceEls = screen.getAllByText('Alice');
    fireEvent.click(aliceEls[0]);
    expect(screen.getByText('Kick')).toBeInTheDocument();
    // Click again to deselect
    fireEvent.click(aliceEls[0]);
    expect(screen.queryByText('Kick')).not.toBeInTheDocument();
  });

  it('kicks a member', async () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByTestId('nav-members'));
    fireEvent.click(screen.getByText('Alice'));
    fireEvent.click(screen.getByText('Kick'));
    const { api } = await import('../services/api');
    expect(api.kickMember).toHaveBeenCalledWith('team1', 'u1');
  });

  it('bans a member', async () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByTestId('nav-members'));
    fireEvent.click(screen.getByText('Alice'));
    fireEvent.click(screen.getByText('Ban'));
    const { api } = await import('../services/api');
    expect(api.banMember).toHaveBeenCalledWith('team1', 'u1');
  });

  // --- Invites Tab ---
  it('shows invite form with max uses and expiry selectors', () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByTestId('nav-invites'));
    expect(screen.getByText('Max Uses')).toBeInTheDocument();
    expect(screen.getByText('Expires After')).toBeInTheDocument();
  });

  it('creates an invite', async () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByTestId('nav-invites'));
    fireEvent.click(screen.getByText('Create Invite'));
    const { api } = await import('../services/api');
    expect(api.createInvite).toHaveBeenCalled();
  });

  // --- Delete Server Tab ---
  it('shows disabled delete button in delete server tab', () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByTestId('nav-delete-server'));
    const deleteBtns = screen.getAllByText('Delete Server');
    // Find the button (not the nav item)
    const deleteBtn = deleteBtns.find(el => el.tagName === 'BUTTON' && el !== screen.getByTestId('nav-delete-server'));
    expect(deleteBtn).toBeTruthy();
  });

  // --- Role color editor ---
  it('shows color picker in role editor', () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByTestId('nav-roles'));
    fireEvent.click(screen.getByText('Admin'));
    expect(screen.getByText('Color')).toBeInTheDocument();
  });

  it('changes role color', () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByTestId('nav-roles'));
    fireEvent.click(screen.getByText('Admin'));
    const colorInput = screen.getByDisplayValue('#ff0000');
    fireEvent.change(colorInput, { target: { value: '#00ff00' } });
    expect(colorInput).toHaveValue('#00ff00');
  });

  it('shows member role toggles with checkboxes for non-default roles', () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByTestId('nav-members'));
    fireEvent.click(screen.getByText('Alice'));
    // Should show Admin role toggle checkbox (non-default)
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes.length).toBeGreaterThanOrEqual(1);
  });

  it('toggles member role via checkbox', async () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByTestId('nav-members'));
    fireEvent.click(screen.getByText('Bob'));
    // Bob has Member role (default), should see Admin checkbox unchecked
    const checkboxes = screen.getAllByRole('checkbox');
    if (checkboxes.length > 0) {
      fireEvent.click(checkboxes[0]);
      const { api } = await import('../services/api');
      expect(api.updateMember).toHaveBeenCalled();
    }
  });

  it('changes max uses selector in invites tab', () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByTestId('nav-invites'));
    const maxUsesSelect = screen.getByDisplayValue('Unlimited');
    fireEvent.change(maxUsesSelect, { target: { value: '10' } });
  });

  it('changes expiry selector in invites tab', () => {
    render(<TeamSettings />);
    fireEvent.click(screen.getByTestId('nav-invites'));
    const expirySelect = screen.getByDisplayValue('1 day');
    fireEvent.change(expirySelect, { target: { value: '168' } });
  });

  it('renders nothing special when no activeTeamId', () => {
    useTeamStore.setState({ activeTeamId: null });
    render(<TeamSettings />);
    // Overview should not render content since team is null
    expect(screen.getByTestId('settings-layout')).toBeInTheDocument();
  });

  it('changes max file size in overview', () => {
    render(<TeamSettings />);
    const fileInput = screen.getByDisplayValue('10485760');
    fireEvent.change(fileInput, { target: { value: '20971520' } });
    expect(fileInput).toHaveValue(20971520);
  });
});
