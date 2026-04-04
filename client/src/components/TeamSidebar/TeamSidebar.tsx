import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'iconoir-react';
import { useAuthStore } from '../../stores/authStore';
import { useTeamStore } from '../../stores/teamStore';

export default function TeamSidebar() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { teams, servers } = useAuthStore();
  const { activeTeamId, setActiveTeam, teams: teamMap } = useTeamStore();

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
    return (
      <div
        key={teamId}
        className={`team-icon-wrapper relative w-12 h-12 ${isActive ? 'active' : ''}`}
        data-testid="team-icon"
        data-active={isActive || undefined}
      >
        <button
          className={`w-[var(--size-avatar-lg)] h-[var(--size-avatar-lg)] rounded-full border-none p-0 font-inherit bg-surface text-brand flex items-center justify-center text-[18px] font-semibold cursor-pointer transition-[border-radius,background-color] duration-200 ease-linear relative hover:rounded-[16px] hover:bg-brand hover:text-white ${isActive ? 'rounded-[16px] !bg-brand !text-white' : ''}`}
          title={name}
          onClick={() => setActiveTeam(teamId)}
        >
          {initial}
        </button>
      </div>
    );
  };

  const hasMultipleServers = serverGroups.length > 1 || (serverGroups.length >= 1 && ungrouped.length > 0);

  return (
    <div className="team-sidebar w-[var(--team-sidebar-width)] bg-glass-tertiary backdrop-blur-glass-heavy flex flex-col items-center py-md px-0 gap-sm h-full box-border overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden max-md:w-full max-md:h-auto max-md:flex-row max-md:flex-wrap max-md:content-start max-md:p-lg max-md:gap-lg max-md:overflow-y-auto">
      <div className="team-list flex flex-col items-center gap-sm flex-1 w-full px-md max-md:flex-row max-md:flex-wrap max-md:justify-start max-md:gap-lg max-md:px-0">
        {serverGroups.map((group, i) => (
          <div key={group.serverId} className="server-group flex flex-col items-center gap-sm w-full max-md:flex-row max-md:flex-wrap max-md:gap-md">
            {hasMultipleServers && (
              <div className="text-[9px] font-semibold uppercase text-interactive tracking-[0.04em] max-w-[48px] overflow-hidden text-ellipsis whitespace-nowrap text-center opacity-60 cursor-default max-md:w-full max-md:max-w-none max-md:text-left" title={group.serverUrl} data-testid="server-label">
                {group.serverId.split('.')[0]}
              </div>
            )}
            {group.teamIds.map(renderTeamIcon)}
            {hasMultipleServers && i < serverGroups.length - 1 && (
              <div className="w-8 h-0.5 bg-surface-active rounded-[1px] my-xs max-md:w-full max-md:h-px max-md:my-xs" data-testid="team-separator" />
            )}
          </div>
        ))}
        {ungrouped.length > 0 && serverGroups.length > 0 && hasMultipleServers && (
          <div className="w-8 h-0.5 bg-surface-active rounded-[1px] my-xs max-md:w-full max-md:h-px max-md:my-xs" />
        )}
        {ungrouped.map(renderTeamIcon)}
        {teamEntries.length > 0 && <div className="w-8 h-0.5 bg-surface-active rounded-[1px] my-xs max-md:w-full max-md:h-px max-md:my-xs" data-testid="team-separator" />}
      </div>
      <button
        className="w-[var(--size-avatar-lg)] h-[var(--size-avatar-lg)] rounded-full bg-surface text-green text-2xl font-normal flex items-center justify-center cursor-pointer border-none p-0 mb-sm transition-[border-radius,background-color,color] duration-200 ease-linear box-border hover:rounded-[16px] hover:bg-green hover:text-white"
        onClick={() => navigate('/join')}
        title={t('sidebar.addTeam')}
        data-testid="team-add"
      >
        <Plus width={20} height={20} strokeWidth={2} />
      </button>
    </div>
  );
}
