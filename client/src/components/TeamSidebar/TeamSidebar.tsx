import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { IconPlus } from '@tabler/icons-react';
import { useAuthStore } from '../../stores/authStore';
import { useTeamStore } from '../../stores/teamStore';
import { useUnreadStore } from '../../stores/unreadStore';
import './TeamSidebar.css';

export default function TeamSidebar() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { teams, servers } = useAuthStore();
  const { activeTeamId, setActiveTeam, teams: teamMap, channels: teamChannels } = useTeamStore();
  const unreadCounts = useUnreadStore((s) => s.counts);

  // Group teams by server
  const serverGroups: { serverId: string; serverUrl: string; teamIds: string[] }[] = [];
  const ungrouped: string[] = [];

  const teamEntries = Array.from(teams.entries());
  const assignedTeams = new Set<string>();

  // Build groups from server entries
  servers.forEach((server, serverId) => {
    const validTeamIds = server.teamIds.filter(id => teams.has(id));
    if (validTeamIds.length > 0) {
      serverGroups.push({ serverId, serverUrl: server.baseUrl, teamIds: validTeamIds });
      validTeamIds.forEach(id => assignedTeams.add(id));
    }
  });

  // Collect ungrouped teams
  teamEntries.forEach(([teamId]) => {
    if (!assignedTeams.has(teamId)) ungrouped.push(teamId);
  });

  const renderTeamIcon = (teamId: string) => {
    const entry = teams.get(teamId);
    if (!entry) return null;
    const freshTeam = teamMap?.get(teamId);
    const authInfo = entry.teamInfo;
    const name = freshTeam?.name ?? (authInfo?.name as string | undefined) ?? teamId;
    const initial = name.charAt(0).toUpperCase();
    const isActive = teamId === activeTeamId;

    const teamChannelList = teamChannels.get(teamId) ?? [];
    const teamUnreadCount = teamChannelList.reduce(
      (sum, ch) => sum + (unreadCounts[ch.id] ?? 0),
      0,
    );

    return (
      <div
        key={teamId}
        className={`team-icon-wrapper ${isActive ? 'active' : ''}`}
        data-tooltip={name}
      >
        <button
          className={`team-icon ${isActive ? 'active' : ''}`}
          title={name}
          onClick={() => setActiveTeam(teamId)}
        >
          {initial}
        </button>
        {teamUnreadCount > 0 && (
          <span className="team-badge">
            {teamUnreadCount > 99 ? '99+' : teamUnreadCount}
          </span>
        )}
      </div>
    );
  };

  const hasMultipleServers = serverGroups.length > 1 || (serverGroups.length >= 1 && ungrouped.length > 0);

  return (
    <div className="team-sidebar">
      <div className="team-list">
        {serverGroups.map((group, i) => (
          <div key={group.serverId} className="server-group">
            {hasMultipleServers && (
              <div className="server-label" title={group.serverUrl}>
                {group.serverId.split('.')[0]}
              </div>
            )}
            {group.teamIds.map(renderTeamIcon)}
            {hasMultipleServers && i < serverGroups.length - 1 && (
              <div className="team-separator" />
            )}
          </div>
        ))}
        {ungrouped.length > 0 && serverGroups.length > 0 && hasMultipleServers && (
          <div className="team-separator" />
        )}
        {ungrouped.map(renderTeamIcon)}
        {teamEntries.length > 0 && <div className="team-separator" />}
      </div>
      <button
        className="team-add"
        onClick={() => navigate('/join')}
        title={t('sidebar.addTeam')}
      >
        <IconPlus size={20} stroke={1.75} />
      </button>
    </div>
  );
}
