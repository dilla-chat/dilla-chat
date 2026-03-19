import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTeamStore, type Channel, type Team, type Role } from '../stores/teamStore';
import { useAuthStore } from '../stores/authStore';
import { usePresenceStore, type UserPresence } from '../stores/presenceStore';
import { useVoiceStore } from '../stores/voiceStore';
import { api, type VoicePeer } from '../services/api';
import { ws } from '../services/websocket';

/**
 * Handles API connection restoration, auth-error redirects, WS setup,
 * sync:init on connect, and REST-fallback data loading.
 */
export function useTeamSync(activeTeamId: string | null): { authChecked: boolean; dataLoaded: MutableRefObject<Set<string>> } {
  const navigate = useNavigate();
  const { teams } = useAuthStore();
  const { setTeam, setChannels, setMembers, setRoles } = useTeamStore();
  const { setPresences, setMyStatus, setMyCustomStatus } = usePresenceStore();

  const [authChecked, setAuthChecked] = useState(false);
  const apiRestored = useRef(false);
  const authErrorFired = useRef(false);
  const dataLoaded = useRef<Set<string>>(new Set());
  const wsConnected = useRef<Set<string>>(new Set());

  // Set up auth error handler
  useEffect(() => {
    api.setAuthErrorHandler(() => {
      if (authErrorFired.current) return;
      authErrorFired.current = true;
      console.warn('Auth token expired — redirecting to login');
      navigate('/login');
    });
  }, [navigate]);

  // Restore API connections from persisted teams on mount
  useEffect(() => {
    if (apiRestored.current) return;
    apiRestored.current = true;
    console.log(`[AppLayout] Restoring API connections for ${teams.size} teams`);
    teams.forEach((entry, teamId) => {
      const baseUrl = entry.baseUrl;
      if (baseUrl) {
        api.addTeam(teamId, baseUrl);
        if (entry.token) api.setToken(teamId, entry.token);
        console.log(`[AppLayout] API restored: ${teamId} → ${baseUrl} (has token: ${!!entry.token})`);
      }
    });

    // Validate token is still accepted by the server
    const firstTeamId = teams.keys().next().value;
    if (firstTeamId) {
      api.getTeam(firstTeamId)
        .then(() => setAuthChecked(true))
        .catch(() => setAuthChecked(true)); // 401 → authErrorHandler fires redirect
    } else {
      setAuthChecked(true);
    }
  }, [teams]);

  // Auto-select first team if none active
  const { setActiveTeam } = useTeamStore();
  useEffect(() => {
    if (!activeTeamId && teams.size > 0) {
      const firstTeamId = teams.keys().next().value;
      if (firstTeamId) setActiveTeam(firstTeamId);
    }
  }, [activeTeamId, teams, setActiveTeam]);

  // Helper: normalize members from server snake_case to client camelCase
  const normalizeMembers = (data: Record<string, unknown>[]) =>
    data.map((m) => ({
      id: m.id as string,
      userId: (m.userId ?? m.user_id) as string,
      username: m.username as string,
      displayName: (m.displayName ?? m.display_name ?? '') as string,
      nickname: (m.nickname ?? '') as string,
      roles: (m.roles ?? []) as Role[],
      statusType: (m.statusType ?? m.status_type ?? '') as string,
    }));

  // Helper: apply sync data to stores
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const applySyncData = (teamId: string, data: any) => {
    if (data.channels) {
      const channels = (data.channels as Record<string, unknown>[]).map((ch) => ({
        ...ch,
        teamId: ch.teamId ?? ch.team_id ?? teamId,
      })) as Channel[];
      setChannels(teamId, channels);
    }
    if (data.team) setTeam(data.team as Team);
    if (data.members) setMembers(teamId, normalizeMembers(data.members as Record<string, unknown>[]));
    if (data.roles) setRoles(teamId, data.roles as Role[]);
    if (data.presences) {
      // Presences from sync:init come as a map of userId -> presence objects
      const presMap: Record<string, UserPresence> = {};
      const raw = data.presences;
      if (raw && typeof raw === 'object') {
        for (const [userId, p] of Object.entries(raw as Record<string, Record<string, unknown>>)) {
          presMap[userId] = {
            user_id: userId,
            status: (p.status ?? p.status_type ?? 'offline') as UserPresence['status'],
            custom_status: (p.custom_status ?? '') as string,
            last_active: (p.last_active ?? '') as string,
          };
        }
      }
      setPresences(teamId, presMap);
      // Sync own status
      const myUserId = teams.get(teamId)?.user?.id;
      if (myUserId && presMap[myUserId]) {
        setMyStatus(presMap[myUserId].status);
        setMyCustomStatus(presMap[myUserId].custom_status || '');
      }
    }
    if (data.voice_states && typeof data.voice_states === 'object') {
      useVoiceStore.getState().setVoiceOccupants(data.voice_states as Record<string, VoicePeer[]>);
    }
    console.log(`[AppLayout] sync:init applied for team ${teamId}`);
  };

  // Fallback: load data via REST if WS sync fails
  const loadDataViaREST = (teamId: string) => {
    console.log(`[AppLayout] Falling back to REST data load for ${teamId}`);
    api.getChannels(teamId).then((data) => {
      const channels = (data as Record<string, unknown>[]).map((ch) => ({
        ...ch,
        teamId: ch.teamId ?? ch.team_id ?? teamId,
      })) as Channel[];
      setChannels(teamId, channels);
    }).catch((err) => console.error('Failed to fetch channels:', err));

    api.getTeam(teamId).then((data) => {
      const team = data as Team;
      if (team && team.id) setTeam(team);
    }).catch((err) => console.error('Failed to fetch team:', err));

    api.getMembers(teamId).then((data) => {
      setMembers(teamId, normalizeMembers(data as Record<string, unknown>[]));
    }).catch((err) => console.error('Failed to fetch members:', err));

    api.getRoles(teamId).then((data) => {
      setRoles(teamId, data as Role[]);
    }).catch((err) => console.error('Failed to fetch roles:', err));

    api.getPresences(teamId).then((data) => {
      setPresences(teamId, data);
      const myUserId = teams.get(teamId)?.user?.id;
      if (myUserId && data[myUserId]) {
        setMyStatus(data[myUserId].status);
        setMyCustomStatus(data[myUserId].custom_status || '');
      }
    }).catch((err) => console.error('Failed to fetch presences:', err));
  };

  // Handle ws:connected — request sync:init to load all team data
  useEffect(() => {
    if (!activeTeamId) return;
    const teamId = activeTeamId;

    const doSyncInit = () => {
      console.log(`[AppLayout] WS connected for team ${teamId}, requesting sync:init`);
      ws.request(teamId, 'sync:init').then((data: unknown) => {
        dataLoaded.current.add(teamId);
        applySyncData(teamId, data as Record<string, unknown>);
      }).catch((err: Error) => {
        console.warn('[AppLayout] sync:init failed, falling back to REST:', err.message);
        if (!dataLoaded.current.has(teamId)) {
          dataLoaded.current.add(teamId);
          loadDataViaREST(teamId);
        }
      });
    };

    const unsub = ws.on('ws:connected', (payload: { teamId?: string }) => {
      if (payload?.teamId !== teamId) return;
      doSyncInit();
    });

    // If WS is already connected (e.g. after HMR), trigger sync immediately
    if (ws.isConnected(teamId) && !dataLoaded.current.has(teamId)) {
      doSyncInit();
    }

    return () => { unsub(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- WS event handlers intentionally capture latest closures; adding applySyncData/loadDataViaREST would cause reconnection loops
  }, [activeTeamId]);

  // Connect WebSocket when team becomes active
  useEffect(() => {
    if (!activeTeamId) return;
    if (wsConnected.current.has(activeTeamId)) return;

    const connInfo = api.getConnectionInfo(activeTeamId);
    if (!connInfo?.token) return;

    const wsUrl = connInfo.baseUrl
      .replace(/^http:/, 'ws:')
      .replace(/^https:/, 'wss:')
      + '/ws';

    console.log(`[AppLayout] Connecting WebSocket for team ${activeTeamId} → ${wsUrl}`);
    ws.connect(activeTeamId, wsUrl, connInfo.token);
    wsConnected.current.add(activeTeamId);
  }, [activeTeamId]);

  return { authChecked, dataLoaded };
}
