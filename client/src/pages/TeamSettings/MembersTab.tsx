import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useTeamStore, type Member } from '../../stores/teamStore';
import { api } from '../../services/api';

export default function MembersTab({ teamId }: Readonly<{ teamId: string }>) {
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
          <button
            key={member.id}
            className={`settings-member-item ${selectedMemberId === member.id ? 'active' : ''}`}
            onClick={() => setSelectedMemberId(member.id === selectedMemberId ? null : member.id)}
            type="button"
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
          </button>
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
