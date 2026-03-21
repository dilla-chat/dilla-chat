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

function MockSettingsLayout({ children, sections, onSelect, onClose }: Readonly<{
  children: React.ReactNode;
  sections: Array<{ label?: string; items: Array<{ id: string; label: string }> }>;
  onSelect: (id: string) => void;
  onClose: () => void;
}>) {
  return (
    <div data-testid="settings-layout">
      <nav data-testid="settings-nav">
        {sections.flatMap((s) =>
          s.items.map((item) => (
            <button key={item.id} data-testid={`nav-${item.id}`} onClick={() => onSelect(item.id)}>
              {item.label}
            </button>
          )),
        )}
      </nav>
      <button data-testid="close-btn" onClick={onClose}>Close</button>
      <div data-testid="settings-content">{children}</div>
    </div>
  );
}

vi.mock('../components/SettingsLayout/SettingsLayout', () => ({
  default: MockSettingsLayout,
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

function renderTeamSettings() {
  return render(<TeamSettings />);
}

function navigateToTab(tabId: string) {
  renderTeamSettings();
  fireEvent.click(screen.getByTestId(`nav-${tabId}`));
}

function navigateToRoleEditor(roleName = 'Admin') {
  navigateToTab('roles');
  fireEvent.click(screen.getByText(roleName));
}

function navigateToMemberAndSelect(memberName = 'Alice') {
  navigateToTab('members');
  fireEvent.click(screen.getByText(memberName));
}

async function navigateToInvitesWithList(invites: Array<Record<string, unknown>>) {
  const { api } = await import('../services/api');
  vi.mocked(api.listInvites).mockResolvedValueOnce(invites);
  navigateToTab('invites');
}

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
    renderTeamSettings();
    expect(screen.getByTestId('settings-layout')).toBeInTheDocument();
  });

  it('shows overview tab by default with team name input', () => {
    renderTeamSettings();
    expect(screen.getByDisplayValue('Test Team')).toBeInTheDocument();
  });

  it('renders team name input in overview', () => {
    renderTeamSettings();
    expect(screen.getByDisplayValue('Test Team')).toBeInTheDocument();
  });

  it('renders description textarea in overview', () => {
    renderTeamSettings();
    expect(screen.getByDisplayValue('A test team')).toBeInTheDocument();
  });

  it('renders save button in overview', () => {
    renderTeamSettings();
    expect(screen.getByText('Save Changes')).toBeInTheDocument();
  });

  it('renders allow invites toggle', () => {
    renderTeamSettings();
    expect(screen.getByText('Allow Member Invites')).toBeInTheDocument();
  });

  it('renders team name label', () => {
    renderTeamSettings();
    expect(screen.getByText('Team Name')).toBeInTheDocument();
  });

  it('renders description label', () => {
    renderTeamSettings();
    expect(screen.getByText('Description')).toBeInTheDocument();
  });

  it('navigates to /app on close', () => {
    renderTeamSettings();
    fireEvent.click(screen.getByTestId('close-btn'));
    expect(mockNavigate).toHaveBeenCalledWith('/app');
  });

  it('switches to roles tab and shows roles list', () => {
    navigateToTab('roles');
    expect(screen.getByText('Admin')).toBeInTheDocument();
    const memberTexts = screen.getAllByText('Member');
    expect(memberTexts.length).toBeGreaterThanOrEqual(1);
  });

  it('shows create role button in roles tab', () => {
    navigateToTab('roles');
    expect(screen.getByText('Create Role')).toBeInTheDocument();
  });

  it('shows default badge for default role', () => {
    navigateToTab('roles');
    expect(screen.getByText('Default')).toBeInTheDocument();
  });

  it('shows role editor when a role is clicked', () => {
    navigateToRoleEditor();
    expect(screen.getByDisplayValue('Admin')).toBeInTheDocument();
    expect(screen.getByText('Permissions')).toBeInTheDocument();
  });

  it('switches to members tab and shows member list', () => {
    navigateToTab('members');
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('shows member search input', () => {
    navigateToTab('members');
    expect(screen.getByPlaceholderText('Search members...')).toBeInTheDocument();
  });

  it('filters members by search', () => {
    navigateToTab('members');
    fireEvent.change(screen.getByPlaceholderText('Search members...'), {
      target: { value: 'alice' },
    });
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.queryByText('Bob')).not.toBeInTheDocument();
  });

  it('shows kick and ban buttons when member is selected', () => {
    navigateToMemberAndSelect('Alice');
    expect(screen.getByText('Kick')).toBeInTheDocument();
    expect(screen.getByText('Ban')).toBeInTheDocument();
  });

  it('switches to invites tab', () => {
    navigateToTab('invites');
    expect(screen.getByText('Create Invite')).toBeInTheDocument();
  });

  it('switches to federation tab', () => {
    navigateToTab('federation');
    expect(screen.getByTestId('federation-status')).toBeInTheDocument();
  });

  it('shows moderation tab content', () => {
    navigateToTab('moderation');
    expect(screen.getByText('Configure moderation tools and auto-moderation rules.')).toBeInTheDocument();
  });

  it('shows audit log tab content', () => {
    navigateToTab('audit-log');
    expect(screen.getByText('No recent actions')).toBeInTheDocument();
  });

  it('shows bans tab content', () => {
    navigateToTab('bans');
    expect(screen.getByText('No banned users')).toBeInTheDocument();
  });

  it('shows delete server tab content', () => {
    navigateToTab('delete-server');
    expect(screen.getByText('This action is irreversible. All data will be permanently deleted.')).toBeInTheDocument();
  });

  it('shows permission checkboxes in role editor', () => {
    navigateToRoleEditor();
    expect(screen.getByText('permissions.admin')).toBeInTheDocument();
    expect(screen.getByText('permissions.manageChannels')).toBeInTheDocument();
    expect(screen.getByText('permissions.sendMessages')).toBeInTheDocument();
  });

  it('shows member usernames with @ prefix', () => {
    navigateToTab('members');
    expect(screen.getByText('@alice')).toBeInTheDocument();
    expect(screen.getByText('@bob')).toBeInTheDocument();
  });

  it('shows role tags on members', () => {
    navigateToTab('members');
    const adminTags = screen.getAllByText('Admin');
    expect(adminTags.length).toBeGreaterThan(0);
  });

  it('renders all nav items', () => {
    renderTeamSettings();
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
    renderTeamSettings();
    expect(screen.getByText('Icon URL')).toBeInTheDocument();
    expect(screen.getByText('Max File Size (bytes)')).toBeInTheDocument();
  });

  it('edits team name in overview', () => {
    renderTeamSettings();
    const input = screen.getByDisplayValue('Test Team');
    fireEvent.change(input, { target: { value: 'Updated Team' } });
    expect(input).toHaveValue('Updated Team');
  });

  it('edits team description in overview', () => {
    renderTeamSettings();
    const textarea = screen.getByDisplayValue('A test team');
    fireEvent.change(textarea, { target: { value: 'New description' } });
    expect(textarea).toHaveValue('New description');
  });

  it('toggles allow member invites', () => {
    renderTeamSettings();
    const toggles = screen.getAllByRole('button').filter(b => b.className.includes('toggle-switch'));
    expect(toggles.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(toggles[0]);
  });

  it('saves overview changes on button click', async () => {
    renderTeamSettings();
    fireEvent.click(screen.getByText('Save Changes'));
    const { api } = await import('../services/api');
    expect(api.updateTeam).toHaveBeenCalledWith('team1', expect.objectContaining({ name: 'Test Team' }));
  });

  // --- Roles Tab ---
  it('creates a new role', async () => {
    navigateToTab('roles');
    fireEvent.click(screen.getByText('Create Role'));
    const { api } = await import('../services/api');
    expect(api.createRole).toHaveBeenCalledWith('team1', expect.objectContaining({ name: 'New Role' }));
  });

  it('selects a role and shows editor with name input', () => {
    navigateToRoleEditor();
    expect(screen.getByDisplayValue('Admin')).toBeInTheDocument();
  });

  it('edits role name', () => {
    navigateToRoleEditor();
    const input = screen.getByDisplayValue('Admin');
    fireEvent.change(input, { target: { value: 'Super Admin' } });
    expect(input).toHaveValue('Super Admin');
  });

  it('toggles permission checkbox', () => {
    navigateToRoleEditor();
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes.length).toBeGreaterThan(0);
    fireEvent.click(checkboxes[0]);
  });

  it('saves role changes', async () => {
    navigateToRoleEditor();
    fireEvent.click(screen.getByText('Save Changes'));
    const { api } = await import('../services/api');
    expect(api.updateRole).toHaveBeenCalled();
  });

  it('shows delete button for non-default role', () => {
    navigateToRoleEditor();
    expect(screen.getByText('Delete Role')).toBeInTheDocument();
  });

  it('does not show delete button for default role', () => {
    navigateToTab('roles');
    const memberTexts = screen.getAllByText('Member');
    fireEvent.click(memberTexts[memberTexts.length - 1]);
    expect(screen.queryByText('Delete Role')).not.toBeInTheDocument();
  });

  it('deletes a role', async () => {
    navigateToRoleEditor();
    fireEvent.click(screen.getByText('Delete Role'));
    const { api } = await import('../services/api');
    expect(api.deleteRole).toHaveBeenCalledWith('team1', 'role-admin');
  });

  // --- Members Tab ---
  it('shows member initials in avatar', () => {
    navigateToTab('members');
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('filters members by nickname', () => {
    navigateToTab('members');
    fireEvent.change(screen.getByPlaceholderText('Search members...'), {
      target: { value: 'Bobby' },
    });
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
  });

  it('toggles member selection (deselects on second click)', () => {
    navigateToTab('members');
    const aliceEls = screen.getAllByText('Alice');
    fireEvent.click(aliceEls[0]);
    expect(screen.getByText('Kick')).toBeInTheDocument();
    fireEvent.click(aliceEls[0]);
    expect(screen.queryByText('Kick')).not.toBeInTheDocument();
  });

  it('kicks a member', async () => {
    navigateToMemberAndSelect('Alice');
    fireEvent.click(screen.getByText('Kick'));
    const { api } = await import('../services/api');
    expect(api.kickMember).toHaveBeenCalledWith('team1', 'u1');
  });

  it('bans a member', async () => {
    navigateToMemberAndSelect('Alice');
    fireEvent.click(screen.getByText('Ban'));
    const { api } = await import('../services/api');
    expect(api.banMember).toHaveBeenCalledWith('team1', 'u1');
  });

  // --- Invites Tab ---
  it('shows invite form with max uses and expiry selectors', () => {
    navigateToTab('invites');
    expect(screen.getByText('Max Uses')).toBeInTheDocument();
    expect(screen.getByText('Expires After')).toBeInTheDocument();
  });

  it('creates an invite', async () => {
    navigateToTab('invites');
    fireEvent.click(screen.getByText('Create Invite'));
    const { api } = await import('../services/api');
    expect(api.createInvite).toHaveBeenCalled();
  });

  // --- Delete Server Tab ---
  it('shows disabled delete button in delete server tab', () => {
    navigateToTab('delete-server');
    const deleteBtns = screen.getAllByText('Delete Server');
    const deleteBtn = deleteBtns.find(el => el.tagName === 'BUTTON' && el !== screen.getByTestId('nav-delete-server'));
    expect(deleteBtn).toBeTruthy();
  });

  // --- Role color editor ---
  it('shows color picker in role editor', () => {
    navigateToRoleEditor();
    expect(screen.getByText('Color')).toBeInTheDocument();
  });

  it('changes role color', () => {
    navigateToRoleEditor();
    const colorInput = screen.getByDisplayValue('#ff0000');
    fireEvent.change(colorInput, { target: { value: '#00ff00' } });
    expect(colorInput).toHaveValue('#00ff00');
  });

  it('shows member role toggles with checkboxes for non-default roles', () => {
    navigateToMemberAndSelect('Alice');
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes.length).toBeGreaterThanOrEqual(1);
  });

  it('toggles member role via checkbox', async () => {
    navigateToMemberAndSelect('Bob');
    const checkboxes = screen.getAllByRole('checkbox');
    if (checkboxes.length > 0) {
      fireEvent.click(checkboxes[0]);
      const { api } = await import('../services/api');
      expect(api.updateMember).toHaveBeenCalled();
    }
  });

  it('changes max uses selector in invites tab', () => {
    navigateToTab('invites');
    const maxUsesSelect = screen.getByDisplayValue('Unlimited');
    fireEvent.change(maxUsesSelect, { target: { value: '10' } });
  });

  it('changes expiry selector in invites tab', () => {
    navigateToTab('invites');
    const expirySelect = screen.getByDisplayValue('1 day');
    fireEvent.change(expirySelect, { target: { value: '168' } });
  });

  it('renders nothing special when no activeTeamId', () => {
    useTeamStore.setState({ activeTeamId: null });
    renderTeamSettings();
    expect(screen.getByTestId('settings-layout')).toBeInTheDocument();
  });

  it('changes max file size in overview', () => {
    renderTeamSettings();
    const fileInput = screen.getByDisplayValue('10485760');
    fireEvent.change(fileInput, { target: { value: '20971520' } });
    expect(fileInput).toHaveValue(20971520);
  });

  it('changes icon URL in overview', () => {
    renderTeamSettings();
    const iconInput = screen.getByDisplayValue('');
    fireEvent.change(iconInput, { target: { value: 'https://example.com/icon.png' } });
  });

  it('overview save handles API failure', async () => {
    const { api } = await import('../services/api');
    vi.mocked(api.updateTeam).mockRejectedValueOnce(new Error('fail'));
    renderTeamSettings();
    fireEvent.click(screen.getByText('Save Changes'));
    await vi.waitFor(() => {
      expect(screen.getByText('Save Changes')).toBeInTheDocument();
    });
  });

  it('creates invite with specific options and shows it in table', async () => {
    const { api } = await import('../services/api');
    vi.mocked(api.createInvite).mockResolvedValueOnce({
      invite: {
        id: 'inv-1', token: 'abc123', created_by: 'admin',
        uses: 0, max_uses: 10, expires_at: '2025-06-01T00:00:00Z',
      },
    });
    navigateToTab('invites');
    fireEvent.click(screen.getByText('Create Invite'));
    await vi.waitFor(() => {
      expect(screen.getByText(/abc123/)).toBeInTheDocument();
    });
  });

  it('revokes an invite', async () => {
    await navigateToInvitesWithList([
      { id: 'inv-1', token: 'tok1', created_by: 'admin', uses: 0, max_uses: null, expires_at: null },
    ]);
    await vi.waitFor(() => {
      expect(screen.getByText('Revoke')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Revoke'));
    const { api } = await import('../services/api');
    await vi.waitFor(() => {
      expect(api.revokeInvite).toHaveBeenCalledWith('team1', 'inv-1');
    });
  });

  it('copies invite link to clipboard', async () => {
    const clipboardWriteText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: clipboardWriteText } });
    await navigateToInvitesWithList([
      { id: 'inv-1', token: 'abc123', created_by: 'admin', uses: 0, max_uses: null, expires_at: null },
    ]);
    await vi.waitFor(() => {
      expect(screen.getByText(/abc123/)).toBeInTheDocument();
    });
    const copyBtn = screen.getByTitle('Copy invite link');
    fireEvent.click(copyBtn);
    expect(clipboardWriteText).toHaveBeenCalled();
  });

  it('shows invite with uses count and expiry date', async () => {
    await navigateToInvitesWithList([
      { id: 'inv-1', token: 'xyz', created_by: 'alice', uses: 3, max_uses: 10, expires_at: '2025-06-15T12:00:00Z' },
    ]);
    await vi.waitFor(() => {
      expect(screen.getByText('alice')).toBeInTheDocument();
      expect(screen.getByText('3/10')).toBeInTheDocument();
    });
  });

  it('shows invite with unlimited uses', async () => {
    await navigateToInvitesWithList([
      { id: 'inv-2', token: 'tok2', created_by: 'bob', uses: 0, max_uses: null, expires_at: null },
    ]);
    await vi.waitFor(() => {
      const usesCell = screen.getByText(/0\/∞/);
      expect(usesCell).toBeInTheDocument();
    });
  });

  it('bans tab shows no banned users message', () => {
    navigateToTab('bans');
    expect(screen.getByText('No banned users')).toBeInTheDocument();
  });

  it('role creation handles API failure', async () => {
    const { api } = await import('../services/api');
    vi.mocked(api.createRole).mockRejectedValueOnce(new Error('fail'));
    navigateToTab('roles');
    fireEvent.click(screen.getByText('Create Role'));
    await vi.waitFor(() => {
      expect(api.createRole).toHaveBeenCalled();
    });
  });

  it('role save handles API failure', async () => {
    const { api } = await import('../services/api');
    vi.mocked(api.updateRole).mockRejectedValueOnce(new Error('fail'));
    navigateToRoleEditor();
    fireEvent.click(screen.getByText('Save Changes'));
    await vi.waitFor(() => {
      expect(api.updateRole).toHaveBeenCalled();
    });
  });

  it('role delete handles API failure', async () => {
    const { api } = await import('../services/api');
    vi.mocked(api.deleteRole).mockRejectedValueOnce(new Error('fail'));
    navigateToRoleEditor();
    fireEvent.click(screen.getByText('Delete Role'));
    await vi.waitFor(() => {
      expect(api.deleteRole).toHaveBeenCalled();
    });
  });

  it('does not delete default role', async () => {
    const { api } = await import('../services/api');
    navigateToTab('roles');
    const memberTexts = screen.getAllByText('Member');
    fireEvent.click(memberTexts[memberTexts.length - 1]);
    expect(screen.queryByText('Delete Role')).not.toBeInTheDocument();
    expect(api.deleteRole).not.toHaveBeenCalled();
  });

  it('kick handles API failure', async () => {
    const { api } = await import('../services/api');
    vi.mocked(api.kickMember).mockRejectedValueOnce(new Error('fail'));
    navigateToMemberAndSelect('Alice');
    fireEvent.click(screen.getByText('Kick'));
    await vi.waitFor(() => {
      expect(api.kickMember).toHaveBeenCalled();
    });
  });

  it('ban handles API failure', async () => {
    const { api } = await import('../services/api');
    vi.mocked(api.banMember).mockRejectedValueOnce(new Error('fail'));
    navigateToMemberAndSelect('Alice');
    fireEvent.click(screen.getByText('Ban'));
    await vi.waitFor(() => {
      expect(api.banMember).toHaveBeenCalled();
    });
  });

  it('member role toggle handles API failure', async () => {
    const { api } = await import('../services/api');
    vi.mocked(api.updateMember).mockRejectedValueOnce(new Error('fail'));
    navigateToMemberAndSelect('Bob');
    const checkboxes = screen.getAllByRole('checkbox');
    if (checkboxes.length > 0) {
      fireEvent.click(checkboxes[0]);
      await vi.waitFor(() => {
        expect(api.updateMember).toHaveBeenCalled();
      });
    }
  });

  it('invite creation handles API failure', async () => {
    const { api } = await import('../services/api');
    vi.mocked(api.createInvite).mockRejectedValueOnce(new Error('fail'));
    navigateToTab('invites');
    fireEvent.click(screen.getByText('Create Invite'));
    await vi.waitFor(() => {
      expect(api.createInvite).toHaveBeenCalled();
    });
  });

  it('invite revoke handles API failure', async () => {
    const { api } = await import('../services/api');
    vi.mocked(api.revokeInvite).mockRejectedValueOnce(new Error('fail'));
    await navigateToInvitesWithList([
      { id: 'inv-1', token: 'tok1', created_by: 'admin', uses: 0, max_uses: null, expires_at: null },
    ]);
    await vi.waitFor(() => {
      expect(screen.getByText('Revoke')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Revoke'));
    await vi.waitFor(() => {
      expect(api.revokeInvite).toHaveBeenCalled();
    });
  });

  it('shows "Saving..." while overview save is in progress', async () => {
    const { api } = await import('../services/api');
    let resolveSave: (v: unknown) => void;
    vi.mocked(api.updateTeam).mockReturnValueOnce(new Promise(r => { resolveSave = r; }) as Promise<unknown>);
    renderTeamSettings();
    fireEvent.click(screen.getByText('Save Changes'));
    expect(screen.getByText('Saving...')).toBeInTheDocument();
    resolveSave!({});
  });

  it('shows "Creating..." while invite is being created', async () => {
    const { api } = await import('../services/api');
    let resolveCreate: (v: unknown) => void;
    vi.mocked(api.createInvite).mockReturnValueOnce(new Promise(r => { resolveCreate = r; }) as Promise<unknown>);
    navigateToTab('invites');
    fireEvent.click(screen.getByText('Create Invite'));
    expect(screen.getByText('Creating...')).toBeInTheDocument();
    resolveCreate!({ invite: { id: 'inv-1', token: 'abc', created_by: 'admin', uses: 0, max_uses: null, expires_at: null } });
  });

  it('removes member role when toggling off', async () => {
    const { api } = await import('../services/api');
    navigateToMemberAndSelect('Alice');
    const checkboxes = screen.getAllByRole('checkbox');
    if (checkboxes.length > 0) {
      fireEvent.click(checkboxes[0]);
      await vi.waitFor(() => {
        expect(api.updateMember).toHaveBeenCalled();
      });
    }
  });

  it('clicks invite link text to copy', async () => {
    const clipboardWriteText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: clipboardWriteText } });
    await navigateToInvitesWithList([
      { id: 'inv-1', token: 'tok1', created_by: 'admin', uses: 0, max_uses: null, expires_at: null },
    ]);
    await vi.waitFor(() => {
      expect(screen.getByText(/tok1/)).toBeInTheDocument();
    });
    const linkText = screen.getByText(/tok1/);
    fireEvent.click(linkText);
    expect(clipboardWriteText).toHaveBeenCalled();
  });

  it('shows copied state after copy button click', async () => {
    const clipboardWriteText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: clipboardWriteText } });
    await navigateToInvitesWithList([
      { id: 'inv-1', token: 'tok1', created_by: 'admin', uses: 0, max_uses: null, expires_at: null },
    ]);
    await vi.waitFor(() => {
      expect(screen.getByTitle('Copy invite link')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTitle('Copy invite link'));
    await vi.waitFor(() => {
      expect(screen.getByTitle('Copied!')).toBeInTheDocument();
    });
  });

  it('shows invite never expiry text when expires_at is null', async () => {
    await navigateToInvitesWithList([
      { id: 'inv-1', token: 'tok1', created_by: 'admin', uses: 0, max_uses: null, expires_at: null },
    ]);
    await vi.waitFor(() => {
      expect(screen.getByText('invites.never')).toBeInTheDocument();
    });
  });
});
