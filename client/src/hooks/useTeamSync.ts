import { useEffect, useRef, useState, type RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTeamStore, type Channel, type Team, type Role } from '../stores/teamStore';
import { useAuthStore } from '../stores/authStore';
import { usePresenceStore, type UserPresence } from '../stores/presenceStore';
import { useVoiceStore } from '../stores/voiceStore';
import { api, type VoicePeer } from '../services/api';
import { ws } from '../services/websocket';
import { telemetryClient } from '../services/telemetryClient';

/** Normalize members from server snake_case to client camelCase */
function normalizeMembers(data: Record<string, unknown>[]) {
  return data.map((m) => ({
    id: m.id as string,
    userId: (m.userId ?? m.user_id) as string,
    username: m.username as string,
    displayName: (m.displayName ?? m.display_name ?? '') as string,
    nickname: (m.nickname ?? '') as string,
    roles: (m.roles ?? []) as Role[],
    statusType: (m.statusType ?? m.status_type ?? '') as string,
  }));
}

interface SyncStoreSetters {
  setTeam: (team: Team) => void;
  setChannels: (teamId: string, channels: Channel[]) => void;
  setMembers: (teamId: string, members: ReturnType<typeof normalizeMembers>) => void;
  setRoles: (teamId: string, roles: Role[]) => void;
  setPresences: (teamId: string, presences: Record<string, UserPresence>) => void;
  setMyStatus: (status: UserPresence['status']) => void;
  setMyCustomStatus: (status: string) => void;
  getMyUserId: (teamId: string) => string | undefined;
}

/** Parse and apply presence data to stores */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyPresences(teamId: string, raw: any, setters: SyncStoreSetters) {
  const presMap: Record<string, UserPresence> = {};
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
  setters.setPresences(teamId, presMap);
  const myUserId = setters.getMyUserId(teamId);
  if (myUserId && presMap[myUserId]) {
    setters.setMyStatus(presMap[myUserId].status);
    setters.setMyCustomStatus(presMap[myUserId].custom_status || '');
  }
}

/** Apply sync:init data to stores */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applySyncData(teamId: string, data: any, setters: SyncStoreSetters) {
  if (data.channels) {
    const channels = (data.channels as Record<string, unknown>[]).map((ch) => ({
      ...ch,
      teamId: ch.teamId ?? ch.team_id ?? teamId,
    })) as Channel[];
    setters.setChannels(teamId, channels);
  }
  if (data.team) setters.setTeam(data.team as Team);
  if (data.members) setters.setMembers(teamId, normalizeMembers(data.members as Record<string, unknown>[]));
  if (data.roles) setters.setRoles(teamId, data.roles as Role[]);
  if (data.presences) {
    applyPresences(teamId, data.presences, setters);
  }
  if (data.voice_states && typeof data.voice_states === 'object') {
    useVoiceStore.getState().setVoiceOccupants(data.voice_states as Record<string, VoicePeer[]>);
  }
  console.log(`[AppLayout] sync:init applied for team ${teamId}`);
}

/** Fallback: load data via REST if WS sync fails */
function loadDataViaREST(teamId: string, setters: SyncStoreSetters) {
  console.log(`[AppLayout] Falling back to REST data load for ${teamId}`);
  api.getChannels(teamId).then((data) => {
    const channels = (data as Record<string, unknown>[]).map((ch) => ({
      ...ch,
      teamId: ch.teamId ?? ch.team_id ?? teamId,
    })) as Channel[];
    setters.setChannels(teamId, channels);
  }).catch((err) => console.error('Failed to fetch channels:', err));

  api.getTeam(teamId).then((data) => {
    const team = data as Team;
    if (team?.id) setters.setTeam(team);
  }).catch((err) => console.error('Failed to fetch team:', err));

  api.getMembers(teamId).then((data) => {
    setters.setMembers(teamId, normalizeMembers(data as Record<string, unknown>[]));
  }).catch((err) => console.error('Failed to fetch members:', err));

  api.getRoles(teamId).then((data) => {
    setters.setRoles(teamId, data as Role[]);
  }).catch((err) => console.error('Failed to fetch roles:', err));

  api.getPresences(teamId).then((data) => {
    setters.setPresences(teamId, data);
    const myUserId = setters.getMyUserId(teamId);
    if (myUserId && data[myUserId]) {
      setters.setMyStatus(data[myUserId].status);
      setters.setMyCustomStatus(data[myUserId].custom_status || '');
    }
  }).catch((err) => console.error('Failed to fetch presences:', err));
}

/** Restore API connections from persisted team entries */
function restoreApiConnections(teams: Map<string, { baseUrl: string; token: string }>) {
  teams.forEach((entry, teamId) => {
    if (!entry.baseUrl) return;
    api.addTeam(teamId, entry.baseUrl);
    if (entry.token) api.setToken(teamId, entry.token);
    console.log(`[AppLayout] API restored: ${teamId} → ${entry.baseUrl} (has token: ${!!entry.token})`);
  });
}

/**
 * Handles API connection restoration, auth-error redirects, WS setup,
 * sync:init on connect, and REST-fallback data loading.
 */
export function useTeamSync(activeTeamId: string | null): { authChecked: boolean; dataLoaded: RefObject<Set<string>> } {
  const navigate = useNavigate();
  const { teams } = useAuthStore();
  const { setTeam, setChannels, setMembers, setRoles } = useTeamStore();
  const { setPresences, setMyStatus, setMyCustomStatus } = usePresenceStore();

  const setters: SyncStoreSetters = {
    setTeam,
    setChannels,
    setMembers,
    setRoles,
    setPresences,
    setMyStatus,
    setMyCustomStatus,
    getMyUserId: (teamId: string) => teams.get(teamId)?.user?.id,
  };

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
    restoreApiConnections(teams);

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

  // Handle ws:connected — request sync:init to load all team data
  useEffect(() => {
    if (!activeTeamId) return;
    const teamId = activeTeamId;

    const doSyncInit = () => {
      console.log(`[AppLayout] WS connected for team ${teamId}, requesting sync:init`);
      ws.request(teamId, 'sync:init').then((data: unknown) => {
        dataLoaded.current.add(teamId);
        applySyncData(teamId, data as Record<string, unknown>, setters);
      }).catch((err: Error) => {
        console.warn('[AppLayout] sync:init failed, falling back to REST:', err.message);
        if (!dataLoaded.current.has(teamId)) {
          dataLoaded.current.add(teamId);
          loadDataViaREST(teamId, setters);
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

    // Safety net: if data still hasn't loaded after 3 seconds (e.g. WS never
    // connected, sync:init stuck, or bootstrap race condition), fall back to REST.
    const fallbackTimer = setTimeout(() => {
      if (!dataLoaded.current.has(teamId)) {
        console.warn(`[AppLayout] Data not loaded after 3 s for team ${teamId}, forcing REST fallback`);
        dataLoaded.current.add(teamId);
        loadDataViaREST(teamId, setters);
      }
    }, 3_000);

    return () => { unsub(); clearTimeout(fallbackTimer); };
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
    telemetryClient.setTeamId(activeTeamId);
  }, [activeTeamId]);

  return { authChecked, dataLoaded };
}
