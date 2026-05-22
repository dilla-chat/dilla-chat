import { useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { IconPlus } from '@tabler/icons-react';
import { useAuthStore } from '../../stores/authStore';
import { useTeamStore } from '../../stores/teamStore';
import { useUnreadStore } from '../../stores/unreadStore';
import { dillaConfirm } from '../../stores/confirmStore';
import { api } from '../../services/api';
import NewServerModal from '../NewServerModal/NewServerModal';
import TeamRailContextMenu from './TeamRailContextMenu';
import './TeamSidebar.css';

interface MenuState {
  teamId: string;
  x: number;
  y: number;
}

export default function TeamSidebar() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { teams, servers, setTeamOrder } = useAuthStore();
  const { activeTeamId, setActiveTeam, teams: teamMap, channels: teamChannels } = useTeamStore();
  const unreadCounts = useUnreadStore((s) => s.counts);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [newServerOpen, setNewServerOpen] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const dragOriginRef = useRef<string | null>(null);

  const serverGroups: { serverId: string; serverUrl: string; teamIds: string[] }[] = [];
  const ungrouped: string[] = [];
  const teamEntries = Array.from(teams.entries());
  const assignedTeams = new Set<string>();

  servers.forEach((server, serverId) => {
    const validTeamIds = server.teamIds.filter((id) => teams.has(id));
    if (validTeamIds.length > 0) {
      serverGroups.push({ serverId, serverUrl: server.baseUrl, teamIds: validTeamIds });
      validTeamIds.forEach((id) => assignedTeams.add(id));
    }
  });
  teamEntries.forEach(([teamId]) => {
    if (!assignedTeams.has(teamId)) ungrouped.push(teamId);
  });

  const handleDragStart = useCallback((teamId: string) => {
    setDraggingId(teamId);
    dragOriginRef.current = teamId;
  }, []);

  const handleDragOver = useCallback(
    (e: React.DragEvent, teamId: string) => {
      e.preventDefault();
      if (dragOriginRef.current && dragOriginRef.current !== teamId) {
        setDropTargetId(teamId);
      }
    },
    [],
  );

  const handleDrop = useCallback(
    (targetId: string) => {
      const source = dragOriginRef.current;
      if (!source || source === targetId) {
        setDraggingId(null);
        setDropTargetId(null);
        return;
      }
      const order = Array.from(teams.keys());
      const fromIdx = order.indexOf(source);
      const toIdx = order.indexOf(targetId);
      if (fromIdx < 0 || toIdx < 0) {
        setDraggingId(null);
        setDropTargetId(null);
        return;
      }
      order.splice(fromIdx, 1);
      order.splice(toIdx, 0, source);
      setTeamOrder(order);
      setDraggingId(null);
      setDropTargetId(null);
      dragOriginRef.current = null;
    },
    [teams, setTeamOrder],
  );

  const handleDragEnd = useCallback(() => {
    setDraggingId(null);
    setDropTargetId(null);
    dragOriginRef.current = null;
  }, []);

  const renderTeamIcon = (teamId: string) => {
    const entry = teams.get(teamId);
    if (!entry) return null;
    const freshTeam = teamMap?.get(teamId);
    const authInfo = entry.teamInfo;
    const name = freshTeam?.name ?? (authInfo?.name as string | undefined) ?? teamId;
    const initial = name.charAt(0).toUpperCase();
    const isActive = teamId === activeTeamId;
    const federated = (authInfo as { federated?: boolean } | undefined)?.federated === true;

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
        data-dragging={draggingId === teamId || undefined}
        data-drop-target={dropTargetId === teamId || undefined}
        draggable
        onDragStart={() => handleDragStart(teamId)}
        onDragOver={(e) => handleDragOver(e, teamId)}
        onDrop={() => handleDrop(teamId)}
        onDragEnd={handleDragEnd}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ teamId, x: e.clientX, y: e.clientY });
        }}
      >
        <button
          className={`team-icon ${isActive ? 'active' : ''}`}
          title={name}
          onClick={() => setActiveTeam(teamId)}
        >
          {initial}
        </button>
        {federated && <span className="team-federated-dot" aria-label="Federated peer" />}
        {teamUnreadCount > 0 && (
          <span className="team-badge">{teamUnreadCount > 99 ? '99+' : teamUnreadCount}</span>
        )}
      </div>
    );
  };

  const hasMultipleServers =
    serverGroups.length > 1 || (serverGroups.length >= 1 && ungrouped.length > 0);

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
        onClick={() => setNewServerOpen(true)}
        title={t('sidebar.addTeam')}
      >
        <IconPlus size={20} stroke={1.75} />
      </button>

      <NewServerModal
        open={newServerOpen}
        onClose={() => setNewServerOpen(false)}
        onJoin={({ serverUrl, invite }) => {
          // Hand off to existing /join flow with prefilled state via URL params
          const params = new URLSearchParams();
          params.set('server', serverUrl);
          params.set('invite', invite);
          navigate(`/join?${params.toString()}`);
        }}
        onCreate={({ name, serverUrl }) => {
          const params = new URLSearchParams();
          params.set('name', name);
          params.set('server', serverUrl);
          navigate(`/setup?${params.toString()}`);
        }}
      />

      {menu && (
        <TeamRailContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onSettings={() => navigate('/app/settings')}
          onInvites={() => navigate('/app/settings')}
          onFederation={() => navigate('/app/settings')}
          onMarkAllRead={() => {
            // H-15: iterate every channel in this team and zero its
            // unread count locally. Server-side persistence of the
            // read-cursor is best-effort via the existing
            // PUT /channels/:id/read endpoint — fired one channel at a
            // time so a single failure doesn't block the others.
            const channels = teamChannels.get(menu.teamId) ?? [];
            const { markRead } = useUnreadStore.getState();
            for (const ch of channels) {
              markRead(ch.id);
              api.markChannelRead(menu.teamId, ch.id).catch((err) => {
                console.warn('[teams] mark-read persist failed', ch.id, err);
              });
            }
          }}
          onLeave={async () => {
            // H-15: leave-team flow. In-app confirm via dillaConfirm
            // (project rule: never window.confirm). On success, remove
            // the team from the local store + navigate away.
            const teamName = teamMap.get(menu.teamId)?.name ?? 'this team';
            const ok = await dillaConfirm({
              title: 'Leave team?',
              body: `You'll be removed from ${teamName}. To rejoin you'll need a new invite.`,
              confirmLabel: 'Leave',
              cancelLabel: 'Cancel',
              danger: true,
            });
            if (!ok) return;
            try {
              await api.leaveTeam(menu.teamId);
              useAuthStore.getState().removeTeam(menu.teamId);
              navigate('/app');
            } catch (err) {
              console.error('[teams] leave failed', err);
            }
          }}
        />
      )}
    </div>
  );
}
