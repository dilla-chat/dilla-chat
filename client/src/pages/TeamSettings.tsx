import { useState, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useTeamStore, type Role, type Member } from '../stores/teamStore';
import { api } from '../services/api';
import FederationStatus from '../components/FederationStatus/FederationStatus';
import SettingsLayout, { type NavSection } from '../components/SettingsLayout/SettingsLayout';
import './TeamSettings.css';

type Tab = 'overview' | 'roles' | 'members' | 'invites' | 'moderation' | 'audit-log' | 'bans' | 'federation' | 'delete-server';

const PERMISSION_FLAGS = [
  { bit: 0x1, label: 'permissions.admin' },
  { bit: 0x2, label: 'permissions.manageChannels' },
  { bit: 0x4, label: 'permissions.manageRoles' },
  { bit: 0x8, label: 'permissions.manageMembers' },
  { bit: 0x10, label: 'permissions.createInvites' },
  { bit: 0x20, label: 'permissions.sendMessages' },
  { bit: 0x40, label: 'permissions.manageMessages' },
  { bit: 0x80, label: 'permissions.voiceConnect' },
  { bit: 0x100, label: 'permissions.voiceSpeak' },
  { bit: 0x200, label: 'permissions.uploadFiles' },
  { bit: 0x400, label: 'permissions.createThreads' },
  { bit: 0x800, label: 'permissions.mentionEveryone' },
];

interface Invite {
  id: string;
  token: string;
  created_by: string;
  uses: number;
  max_uses: number | null;
  expires_at: string | null;
}

export default function TeamSettings() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { activeTeamId, teams, setTeam } = useTeamStore();
  const [tab, setTab] = useState<Tab>('overview');

  const team = activeTeamId ? teams.get(activeTeamId) : null;

  const sections: NavSection[] = useMemo(
    () => [
      {
        label: team?.name ?? t('teams.settings'),
        items: [
          { id: 'overview', label: t('settings.overview', 'Overview') },
          { id: 'roles', label: t('settings.roles') },
          { id: 'members', label: t('settings.members') },
          { id: 'invites', label: t('settings.invites') },
        ],
      },
      {
        label: t('settings.moderationCategory', 'MODERATION'),
        items: [
          { id: 'moderation', label: t('settings.moderation') },
          { id: 'audit-log', label: t('settings.auditLog', 'Audit Log') },
          { id: 'bans', label: t('settings.bans', 'Bans') },
        ],
      },
      {
        items: [{ id: 'federation', label: t('settings.federation') }],
      },
      {
        items: [{ id: 'delete-server', label: t('settings.deleteServer', 'Delete Server'), danger: true }],
      },
    ],
    [t, team?.name],
  );

  const handleClose = () => navigate('/app');

  return (
    <SettingsLayout
      sections={sections}
      activeId={tab}
      onSelect={(id) => setTab(id as Tab)}
      onClose={handleClose}
    >
      {tab === 'overview' && activeTeamId && team && (
        <OverviewTab teamId={activeTeamId} team={team} onSave={setTeam} />
      )}
      {tab === 'roles' && activeTeamId && <RolesTab teamId={activeTeamId} />}
      {tab === 'members' && activeTeamId && <MembersTab teamId={activeTeamId} />}
      {tab === 'invites' && activeTeamId && <InvitesTab teamId={activeTeamId} />}
      {tab === 'federation' && activeTeamId && <FederationStatus teamId={activeTeamId} />}
      {tab === 'moderation' && activeTeamId && <ModerationTab teamId={activeTeamId} />}
      {tab === 'audit-log' && (
        <div className="settings-section">
          <h2>{t('settings.auditLog', 'Audit Log')}</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>
            {t('moderation.noActions', 'No recent actions')}
          </p>
        </div>
      )}
      {tab === 'bans' && activeTeamId && <BansTab teamId={activeTeamId} />}
      {tab === 'delete-server' && (
        <div className="settings-section">
          <h2>{t('settings.deleteServer', 'Delete Server')}</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>
            {t('settings.deleteServerDesc', 'This action is irreversible. All data will be permanently deleted.')}
          </p>
          <button className="btn-danger" style={{ marginTop: 16 }} disabled>
            {t('settings.deleteServer', 'Delete Server')}
          </button>
        </div>
      )}
    </SettingsLayout>
  );
}

/* ─── Overview Tab (was General) ─── */
function OverviewTab({
  teamId,
  team,
  onSave,
}: {
  teamId: string;
  team: ReturnType<typeof useTeamStore.getState>['teams'] extends Map<string, infer T> ? T : never;
  onSave: (t: typeof team) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(team.name);
  const [description, setDescription] = useState(team.description);
  const [iconUrl, setIconUrl] = useState(team.iconUrl);
  const [maxFileSize, setMaxFileSize] = useState(team.maxFileSize);
  const [allowInvites, setAllowInvites] = useState(team.allowMemberInvites);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.updateTeam(teamId, {
        name,
        description,
        icon_url: iconUrl,
        max_file_size: maxFileSize,
        allow_member_invites: allowInvites,
      });
      onSave({ ...team, name, description, iconUrl, maxFileSize, allowMemberInvites: allowInvites });
    } catch {
      // Error handled silently for now
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-section">
      <h2>{t('settings.overview', 'Overview')}</h2>

      <div className="settings-field">
        <label>{t('settings.teamName', 'Team Name')}</label>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </div>

      <div className="settings-field">
        <label>{t('settings.description', 'Description')}</label>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>

      <div className="settings-field">
        <label>{t('settings.iconUrl', 'Icon URL')}</label>
        <input value={iconUrl} onChange={(e) => setIconUrl(e.target.value)} />
      </div>

      <div className="settings-field">
        <label>{t('settings.maxFileSize', 'Max File Size (bytes)')}</label>
        <input
          type="number"
          value={maxFileSize}
          onChange={(e) => setMaxFileSize(Number(e.target.value))}
        />
      </div>

      <div className="settings-toggle">
        <div className="settings-toggle-info">
          <div className="settings-toggle-label">
            {t('settings.allowInvites', 'Allow Member Invites')}
          </div>
          <div className="settings-toggle-desc">
            {t('settings.allowInvitesDesc', 'Let non-admin members create invite links')}
          </div>
        </div>
        <button
          className={`toggle-switch ${allowInvites ? 'active' : ''}`}
          onClick={() => setAllowInvites(!allowInvites)}
        />
      </div>

      <div style={{ marginTop: 24 }}>
        <button className="btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? t('common.saving', 'Saving...') : t('common.save', 'Save Changes')}
        </button>
      </div>
    </div>
  );
}

/* ─── Roles Tab ─── */
function RolesTab({ teamId }: { teamId: string }) {
  const { t } = useTranslation();
  const { roles, setRoles } = useTeamStore();
  const teamRoles = roles.get(teamId) ?? [];
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState('#8fa3b8');
  const [editPermissions, setEditPermissions] = useState(0);

  const selectedRole = teamRoles.find((r) => r.id === selectedRoleId);

  const selectRole = (role: Role) => {
    setSelectedRoleId(role.id);
    setEditName(role.name);
    setEditColor(role.color || '#8fa3b8');
    setEditPermissions(role.permissions);
  };

  const handleCreateRole = async () => {
    try {
      const result = (await api.createRole(teamId, {
        name: 'New Role',
        color: '#8fa3b8',
        permissions: 0,
      })) as Role;
      setRoles(teamId, [...teamRoles, result]);
      selectRole(result);
    } catch {
      // Error
    }
  };

  const handleSaveRole = async () => {
    if (!selectedRoleId) return;
    try {
      await api.updateRole(teamId, selectedRoleId, {
        name: editName,
        color: editColor,
        permissions: editPermissions,
      });
      setRoles(
        teamId,
        teamRoles.map((r) =>
          r.id === selectedRoleId
            ? { ...r, name: editName, color: editColor, permissions: editPermissions }
            : r,
        ),
      );
    } catch {
      // Error
    }
  };

  const handleDeleteRole = async () => {
    if (!selectedRoleId || selectedRole?.isDefault) return;
    try {
      await api.deleteRole(teamId, selectedRoleId);
      setRoles(
        teamId,
        teamRoles.filter((r) => r.id !== selectedRoleId),
      );
      setSelectedRoleId(null);
    } catch {
      // Error
    }
  };

  const togglePermission = (bit: number) => {
    setEditPermissions((prev) => (prev & bit ? prev & ~bit : prev | bit));
  };

  return (
    <div className="settings-section">
      <h2>{t('settings.roles')}</h2>

      <button className="btn-primary" onClick={handleCreateRole} style={{ marginBottom: 16 }}>
        {t('roles.create', 'Create Role')}
      </button>

      <div className="roles-list">
        {[...teamRoles].sort((a, b) => b.position - a.position).map((role) => (
          <div
            key={role.id}
            className={`role-item ${selectedRoleId === role.id ? 'active' : ''}`}
            onClick={() => selectRole(role)}
          >
            <span className="role-color-circle" style={{ background: role.color || '#8fa3b8' }} />
            <span className="role-name">{role.name}</span>
            {role.isDefault && <span className="role-default-badge">{t('roles.default', 'Default')}</span>}
          </div>
        ))}
      </div>

      {selectedRole && (
        <div className="role-editor">
          <div className="settings-field">
            <label>{t('roles.name', 'Role Name')}</label>
            <input value={editName} onChange={(e) => setEditName(e.target.value)} />
          </div>

          <div className="settings-field">
            <label>{t('roles.color', 'Color')}</label>
            <input
              type="color"
              value={editColor}
              onChange={(e) => setEditColor(e.target.value)}
              style={{ width: 60, height: 36, padding: 2 }}
            />
          </div>

          <h3>{t('roles.permissions', 'Permissions')}</h3>
          <div className="permissions-grid">
            {PERMISSION_FLAGS.map(({ bit, label }) => (
              <label key={bit} className="permission-check">
                <input
                  type="checkbox"
                  checked={(editPermissions & bit) !== 0}
                  onChange={() => togglePermission(bit)}
                />
                {t(label)}
              </label>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 12, marginTop: 20 }}>
            <button className="btn-primary" onClick={handleSaveRole}>
              {t('common.save', 'Save Changes')}
            </button>
            {!selectedRole.isDefault && (
              <button className="btn-danger" onClick={handleDeleteRole}>
                {t('roles.delete', 'Delete Role')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Members Tab ─── */
function MembersTab({ teamId }: { teamId: string }) {
  const { t } = useTranslation();
  const { members, roles, setMembers } = useTeamStore();
  const teamMembers = members.get(teamId) ?? [];
  const teamRoles = roles.get(teamId) ?? [];
  const [search, setSearch] = useState('');
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return teamMembers.filter(
      (m) =>
        m.username.toLowerCase().includes(q) ||
        m.displayName.toLowerCase().includes(q) ||
        m.nickname.toLowerCase().includes(q),
    );
  }, [teamMembers, search]);

  const selectedMember = teamMembers.find((m) => m.id === selectedMemberId);

  const getInitials = (m: Member) =>
    (m.displayName || m.username)
      .split(' ')
      .map((w) => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();

  const handleKick = async (userId: string) => {
    try {
      await api.kickMember(teamId, userId);
      setMembers(
        teamId,
        teamMembers.filter((m) => m.userId !== userId),
      );
      setSelectedMemberId(null);
    } catch {
      // Error
    }
  };

  const handleBan = async (userId: string) => {
    try {
      await api.banMember(teamId, userId);
      setMembers(
        teamId,
        teamMembers.filter((m) => m.userId !== userId),
      );
      setSelectedMemberId(null);
    } catch {
      // Error
    }
  };

  const handleRoleToggle = async (member: Member, roleId: string, add: boolean) => {
    const currentRoleIds = member.roles.map((r) => r.id);
    const newRoleIds = add
      ? [...currentRoleIds, roleId]
      : currentRoleIds.filter((id) => id !== roleId);
    try {
      await api.updateMember(teamId, member.userId, { role_ids: newRoleIds });
      const role = teamRoles.find((r) => r.id === roleId);
      if (role) {
        const updatedRoles = add
          ? [...member.roles, role]
          : member.roles.filter((r) => r.id !== roleId);
        setMembers(
          teamId,
          teamMembers.map((m) => (m.id === member.id ? { ...m, roles: updatedRoles } : m)),
        );
      }
    } catch {
      // Error
    }
  };

  return (
    <div className="settings-section">
      <h2>{t('settings.members')}</h2>

      <div className="members-search">
        <input
          placeholder={t('members.search', 'Search members...')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="settings-member-list">
        {filtered.map((member) => (
          <div
            key={member.id}
            className={`settings-member-item ${selectedMemberId === member.id ? 'active' : ''}`}
            onClick={() => setSelectedMemberId(member.id === selectedMemberId ? null : member.id)}
          >
            <div className="settings-member-avatar">{getInitials(member)}</div>
            <div className="settings-member-info">
              <div className="settings-member-name">
                {member.displayName || member.username}
              </div>
              <div className="settings-member-username">@{member.username}</div>
            </div>
            <div className="settings-member-roles">
              {member.roles.map((r) => (
                <span key={r.id} className="settings-member-role-tag">
                  {r.name}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

      {selectedMember && (
        <div className="member-actions-panel">
          <h4>{selectedMember.displayName || selectedMember.username}</h4>

          <div className="member-role-toggles">
            {teamRoles
              .filter((r) => !r.isDefault)
              .map((role) => {
                const hasRole = selectedMember.roles.some((r) => r.id === role.id);
                return (
                  <label key={role.id} className="member-role-toggle">
                    <input
                      type="checkbox"
                      checked={hasRole}
                      onChange={() => handleRoleToggle(selectedMember, role.id, !hasRole)}
                    />
                    {role.name}
                  </label>
                );
              })}
          </div>

          <div className="member-danger-actions">
            <button className="btn-danger" onClick={() => handleKick(selectedMember.userId)}>
              {t('members.kick', 'Kick')}
            </button>
            <button className="btn-danger" onClick={() => handleBan(selectedMember.userId)}>
              {t('members.ban', 'Ban')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Invites Tab ─── */
function InvitesTab({ teamId }: { teamId: string }) {
  const { t } = useTranslation();
  const [invites, setInvites] = useState<Invite[]>([]);
  const [maxUses, setMaxUses] = useState<string>('0');
  const [expiry, setExpiry] = useState<string>('24');
  const [creating, setCreating] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    api.listInvites(teamId).then((data) => setInvites(data as Invite[])).catch(() => {});
  }, [teamId]);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const maxUsesNum = Number(maxUses) || undefined;
      const expiryHours = Number(expiry) || undefined;
      const result = (await api.createInvite(teamId, maxUsesNum, expiryHours)) as { invite: Invite };
      setInvites((prev) => [result.invite, ...prev]);
    } catch {
      // Error
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (inviteId: string) => {
    try {
      await api.revokeInvite(teamId, inviteId);
      setInvites((prev) => prev.filter((i) => i.id !== inviteId));
    } catch {
      // Error
    }
  };

  const getInviteLink = (token: string) => `${window.location.origin}/join/${token}`;

  const copyLink = (inviteId: string, token: string) => {
    navigator.clipboard.writeText(getInviteLink(token)).catch(() => {});
    setCopiedId(inviteId);
    setTimeout(() => setCopiedId((prev) => (prev === inviteId ? null : prev)), 2000);
  };

  return (
    <div className="settings-section">
      <h2>{t('settings.invites')}</h2>

      <div className="invite-form">
        <div className="settings-field">
          <label>{t('invites.maxUses', 'Max Uses')}</label>
          <select value={maxUses} onChange={(e) => setMaxUses(e.target.value)}>
            <option value="0">{t('invites.unlimited', 'Unlimited')}</option>
            <option value="1">1</option>
            <option value="5">5</option>
            <option value="10">10</option>
            <option value="25">25</option>
            <option value="50">50</option>
            <option value="100">100</option>
          </select>
        </div>

        <div className="settings-field">
          <label>{t('invites.expiry', 'Expires After')}</label>
          <select value={expiry} onChange={(e) => setExpiry(e.target.value)}>
            <option value="0.5">{t('invites.30min', '30 minutes')}</option>
            <option value="1">{t('invites.1hour', '1 hour')}</option>
            <option value="6">{t('invites.6hours', '6 hours')}</option>
            <option value="12">{t('invites.12hours', '12 hours')}</option>
            <option value="24">{t('invites.1day', '1 day')}</option>
            <option value="168">{t('invites.7days', '7 days')}</option>
            <option value="0">{t('invites.never', 'Never')}</option>
          </select>
        </div>

        <button className="btn-primary" onClick={handleCreate} disabled={creating}>
          {creating ? t('common.creating', 'Creating...') : t('invites.create', 'Create Invite')}
        </button>
      </div>

      {invites.length > 0 && (
        <table className="invites-table">
          <thead>
            <tr>
              <th>{t('invites.link', 'Invite Link')}</th>
              <th>{t('invites.createdBy', 'Created By')}</th>
              <th>{t('invites.uses', 'Uses')}</th>
              <th>{t('invites.expiresAt', 'Expires')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {invites.map((inv) => {
              const link = getInviteLink(inv.token);
              const isCopied = copiedId === inv.id;
              return (
                <tr key={inv.id}>
                  <td>
                    <div className="invite-link-cell">
                      <span
                        className="invite-link-text"
                        onClick={() => copyLink(inv.id, inv.token)}
                        title={link}
                      >
                        {link.length > 48 ? `${link.slice(0, 48)}…` : link}
                      </span>
                      <button
                        className={`invite-copy-btn${isCopied ? ' copied' : ''}`}
                        onClick={() => copyLink(inv.id, inv.token)}
                        title={isCopied ? t('invites.copied', 'Copied!') : t('invites.copyLink', 'Copy invite link')}
                      >
                        {isCopied ? '✓' : '⎘'}
                      </button>
                    </div>
                  </td>
                  <td>{inv.created_by}</td>
                  <td>
                    {inv.uses}/{inv.max_uses ?? '∞'}
                  </td>
                  <td>{inv.expires_at ? new Date(inv.expires_at).toLocaleString() : t('invites.never')}</td>
                  <td>
                    <button className="btn-danger" onClick={() => handleRevoke(inv.id)}>
                      {t('invites.revoke', 'Revoke')}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

/* ─── Moderation Tab ─── */
function ModerationTab({ teamId: _teamId }: { teamId: string }) {
  const { t } = useTranslation();

  return (
    <div className="settings-section">
      <h2>{t('settings.moderation')}</h2>
      <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>
        {t('settings.moderationDesc', 'Configure moderation tools and auto-moderation rules.')}
      </p>
    </div>
  );
}

/* ─── Bans Tab ─── */
function BansTab({ teamId }: { teamId: string }) {
  const { t } = useTranslation();
  const [bannedUsers, setBannedUsers] = useState<Array<{ id: string; username: string }>>([]);

  const handleUnban = async (userId: string) => {
    try {
      await api.unbanMember(teamId, userId);
      setBannedUsers((prev) => prev.filter((u) => u.id !== userId));
    } catch {
      // Error
    }
  };

  return (
    <div className="settings-section">
      <h2>{t('settings.bans', 'Bans')}</h2>
      <div className="banned-users-list">
        {bannedUsers.length === 0 && (
          <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>
            {t('members.noBanned', 'No banned users')}
          </p>
        )}
        {bannedUsers.map((user) => (
          <div key={user.id} className="banned-user-item">
            <span className="banned-user-name">{user.username}</span>
            <button className="btn-secondary" onClick={() => handleUnban(user.id)}>
              {t('members.unban', 'Unban')}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
