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
    <div>
      <h2 className="text-foreground-primary mb-5">{t('settings.members')}</h2>

      <div className="mb-4">
        <input
          className="form-input"
          placeholder={t('members.search', 'Search members...')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-0.5">
        {filtered.map((member) => (
          <button
            key={member.id}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-sm border-none text-left cursor-pointer transition-colors duration-150 hover:bg-surface-hover ${selectedMemberId === member.id ? 'bg-surface-active' : 'bg-transparent'}`}
            onClick={() => setSelectedMemberId(member.id === selectedMemberId ? null : member.id)}
            type="button"
          >
            <div className="w-8 h-8 rounded-full bg-accent text-white flex items-center justify-center text-xs font-semibold shrink-0">{getInitials(member)}</div>
            <div className="flex-1 min-w-0">
              <div className="text-base text-foreground-primary font-medium truncate">
                {member.displayName || member.username}
              </div>
              <div className="text-sm text-foreground-secondary">@{member.username}</div>
            </div>
            <div className="flex gap-1 flex-wrap">
              {member.roles.map((r) => (
                <span key={r.id} className="text-xs bg-surface-tertiary text-foreground-secondary px-1.5 py-0.5 rounded-sm">
                  {r.name}
                </span>
              ))}
            </div>
          </button>
        ))}
      </div>

      {selectedMember && (
        <div className="mt-5 pt-5 border-t border-border-subtle">
          <h4 className="text-base font-semibold text-foreground-primary mb-3">{selectedMember.displayName || selectedMember.username}</h4>

          <div className="flex flex-col gap-1.5 mb-4">
            {teamRoles
              .filter((r) => !r.isDefault)
              .map((role) => {
                const hasRole = selectedMember.roles.some((r) => r.id === role.id);
                return (
                  <label key={role.id} className="flex items-center gap-2 text-sm text-foreground-primary cursor-pointer py-1">
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

          <div className="flex gap-3">
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
