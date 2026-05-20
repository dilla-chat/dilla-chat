import { useEffect, useRef, useState, type RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTeamStore, type Channel, type Team, type Role } from '../stores/teamStore';
import { useAuthStore } from '../stores/authStore';
import { usePresenceStore, type UserPresence } from '../stores/presenceStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useUnreadStore } from '../stores/unreadStore';
import { api, type VoicePeer } from '../services/api';
import { ws } from '../services/websocket';
import { telemetryClient } from '../services/telemetryClient';
import { cryptoService } from '../services/crypto';

/** Normalize members from server snake_case to client camelCase.
 *  sync:init returns `{ member: {...}, user: {...} }` wrappers;
 *  REST returns flat objects. Handle both. */
function normalizeMembers(data: Record<string, unknown>[]) {
  return data.map((raw) => {
    // Unwrap nested { member, user } format from sync:init
    const mem = (raw.member ?? raw) as Record<string, unknown>;
    const usr = (raw.user ?? raw) as Record<string, unknown>;
    const roleIds = (raw.role_ids ?? raw.roleIds ?? mem.role_ids ?? mem.roleIds ?? []) as string[];
    return {
      id: (mem.id ?? raw.id) as string,
      userId: (mem.user_id ?? mem.userId ?? usr.id ?? raw.user_id ?? raw.userId) as string,
      username: (usr.username ?? raw.username ?? '') as string,
      displayName: (usr.display_name ?? usr.displayName ?? raw.display_name ?? raw.displayName ?? '') as string,
      nickname: (mem.nickname ?? raw.nickname ?? '') as string,
      roleIds,
      // Roles will be populated later once both members and roles are in the
      // store (see resolveMemberRoles below). Kept here as an empty fallback
      // to satisfy the existing Member type.
      roles: (mem.roles ?? raw.roles ?? []) as Role[],
      statusType: (usr.status_type ?? usr.statusType ?? raw.status_type ?? raw.statusType ?? '') as string,
      // isAdmin is now derived from role permissions, not a global flag.
      isAdmin: false,
      // Member.publicKeyHex is required by the store type (safety-number
      // compare uses it). Fall back to empty string until the server
      // surfaces it on the sync/REST payload.
      publicKeyHex: (mem.public_key_hex ?? usr.public_key_hex ?? raw.public_key_hex ?? '') as string,
    };
  });
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
      accessRoleIds: (ch.access_role_ids ?? ch.accessRoleIds ?? []) as string[],
      slowModeSeconds: (ch.slow_mode_seconds ?? ch.slowModeSeconds ?? 0) as number,
      hiddenIfRestricted: Boolean(ch.hidden_if_restricted ?? ch.hiddenIfRestricted),
    })) as Channel[];
    setters.setChannels(teamId, channels);
  }
  if (data.team) setters.setTeam(data.team as Team);
  const normalizedMembers = data.members
    ? normalizeMembers(data.members as Record<string, unknown>[])
    : null;
  const normalizedRoles = data.roles
    ? ((data.roles as Record<string, unknown>[]).map((r) => ({
        id: r.id as string,
        name: r.name as string,
        color: (r.color as string) ?? '',
        position: (r.position as number) ?? 0,
        permissions: (r.permissions as number) ?? 0,
        isDefault: Boolean(r.isDefault ?? r.is_default),
      })) as Role[])
    : null;
  if (normalizedRoles) setters.setRoles(teamId, normalizedRoles);
  if (normalizedMembers) {
    const rolesById = new Map((normalizedRoles ?? []).map((r) => [r.id, r]));
    const PERM_ADMIN = 1 << 0;
    const resolved = normalizedMembers.map((m) => {
      const roles = (m.roleIds ?? [])
        .map((id) => rolesById.get(id))
        .filter((r): r is Role => !!r);
      const isAdmin = roles.some((r) => (r.permissions & PERM_ADMIN) !== 0);
      return { ...m, roles, isAdmin };
    });
    setters.setMembers(teamId, resolved);
  }
  if (data.presences) {
    applyPresences(teamId, data.presences, setters);
  }
  if (data.voice_states && typeof data.voice_states === 'object') {
    useVoiceStore.getState().setVoiceOccupants(data.voice_states as Record<string, VoicePeer[]>);
  }
  if (data.unread_counts && typeof data.unread_counts === 'object') {
    useUnreadStore.getState().setCounts(data.unread_counts as Record<string, number>);
  }
  console.log(`[AppLayout] sync:init applied for team ${teamId}`);

  // sync:init doesn't include the live PresenceManager state; members'
  // status_type comes from the DB default ('online' at registration) and
  // never updates. Always fetch the live presence map separately so
  // disconnected users show as offline immediately after a reload.
  if (!data.presences) {
    api.getPresences(teamId)
      .then((pres) => applyPresences(teamId, pres as Record<string, UserPresence>, setters))
      .catch((err) => console.warn('[AppLayout] getPresences after sync:init failed', err));
  }

  // Now that sync is complete and channels are known, flush any messages
  // that were queued while the WebSocket was reconnecting.
  ws.flushPendingMessages(teamId);
}

/** Fallback: load data via REST if WS sync fails */
function loadDataViaREST(teamId: string, setters: SyncStoreSetters) {
  console.log(`[AppLayout] Falling back to REST data load for ${teamId}`);
  api.getChannels(teamId).then((data) => {
    const channels = (data as Record<string, unknown>[]).map((ch) => ({
      ...ch,
      teamId: ch.teamId ?? ch.team_id ?? teamId,
      accessRoleIds: (ch.access_role_ids ?? ch.accessRoleIds ?? []) as string[],
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
    api.setAuthErrorHandler(async () => {
      if (authErrorFired.current) return;
      authErrorFired.current = true;
      console.warn('Auth token expired — disconnecting WS and redirecting to login');
      ws.disconnectAll();
      const { resetCrypto } = await import('../services/crypto');
      resetCrypto();
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

  // Connect WebSocket when team becomes active or token changes
  const activeToken = activeTeamId ? teams.get(activeTeamId)?.token : null;
  useEffect(() => {
    if (!activeTeamId || !activeToken) return;

    const connInfo = api.getConnectionInfo(activeTeamId);
    if (!connInfo?.token) return;

    // Reconnect if token changed (e.g. after auth reconnect refreshed it)
    if (wsConnected.current.has(activeTeamId) && ws.isConnected(activeTeamId)) return;
    wsConnected.current.delete(activeTeamId);

    const wsUrl = connInfo.baseUrl
      .replace(/^http:/, 'ws:')
      .replace(/^https:/, 'wss:')
      + '/ws';

    // Request a single-use ticket for WS auth (avoids JWT in URL).
    // Falls back to token if ticket request fails.
    const teamIdForClosure = activeTeamId;
    const getAuthParam = async (): Promise<string> => {
      try {
        const ticket = await api.getWsTicket(teamIdForClosure);
        return `ticket=${encodeURIComponent(ticket)}`;
      } catch {
        return `token=${encodeURIComponent(connInfo.token!)}`;
      }
    };

    (async () => {
      const authParam = await getAuthParam();
      console.log(`[AppLayout] Connecting WebSocket for team ${activeTeamId} → ${wsUrl}`);
      ws.connectWithParams(activeTeamId, wsUrl, authParam, getAuthParam);
      wsConnected.current.add(activeTeamId);
      telemetryClient.setTeamId(activeTeamId);
    })();
  }, [activeTeamId, activeToken]);

  // Increment unread count for messages on channels the user is not currently viewing,
  // and handle channel:read events broadcast from other devices.
  useEffect(() => {
    if (!activeTeamId) return;

    const unsubMsgNew = ws.on('message:new', (payload: { channel_id?: string }) => {
      if (!payload?.channel_id) return;
      const activeChannelId = useTeamStore.getState().activeChannelId;
      if (payload.channel_id !== activeChannelId) {
        useUnreadStore.getState().increment(payload.channel_id);
      }
    });

    const unsubChannelRead = ws.on('channel:read', (payload: { channel_id?: string }) => {
      if (!payload?.channel_id) return;
      useUnreadStore.getState().markRead(payload.channel_id);
    });

    // Refresh sidebar entries when a channel mutates (rename, topic, lock).
    const unsubChannelUpdated = ws.on('channel:updated', (payload: Record<string, unknown>) => {
      if (!payload?.id) return;
      const teamIdFromPayload = (payload.team_id ?? payload.teamId) as string | undefined;
      if (!teamIdFromPayload) return;
      const teamStore = useTeamStore.getState();
      const list = teamStore.channels.get(teamIdFromPayload) ?? [];
      const idx = list.findIndex((c) => c.id === payload.id);
      const updated: Channel = {
        ...(idx >= 0 ? list[idx] : ({} as Channel)),
        ...payload,
        teamId: teamIdFromPayload,
        accessRoleIds: (payload.access_role_ids ?? payload.accessRoleIds ?? (idx >= 0 ? list[idx].accessRoleIds : [])) as string[],
      } as Channel;
      const next = idx >= 0 ? list.map((c, i) => (i === idx ? updated : c)) : [...list, updated];
      teamStore.setChannels(teamIdFromPayload, next);
    });

    // Member role changes: patch the affected member in-place (roleIds +
    // roles + isAdmin) so the rail / role groups / access gating react
    // without a re-sync, and toast the affected user if they're the one
    // being changed.
    const unsubMemberRoles = ws.on(
      'member:roles-updated',
      (payload: { team_id?: string; user_id?: string; actor_user_id?: string; role_ids?: string[] }) => {
        if (!payload?.team_id || !payload?.user_id || !payload?.role_ids) return;
        const teamStore = useTeamStore.getState();
        const list = teamStore.members.get(payload.team_id) ?? [];
        const rolesById = new Map((teamStore.roles.get(payload.team_id) ?? []).map((r) => [r.id, r]));
        const PERM_ADMIN = 1 << 0;
        const nextRoles = payload.role_ids
          .map((id) => rolesById.get(id))
          .filter((r): r is NonNullable<typeof r> => !!r);
        const isAdmin = nextRoles.some((r) => (r.permissions & PERM_ADMIN) !== 0);
        const next = list.map((m) =>
          m.userId === payload.user_id
            ? { ...m, roleIds: payload.role_ids!, roles: nextRoles, isAdmin }
            : m,
        );
        teamStore.setMembers(payload.team_id, next);

        // Toast the affected user. Skip when they're the actor (they
        // triggered the change themselves) or when the event isn't about
        // the current user at all.
        const myUserId = (window as { SHELL_DATA?: { currentUserId?: string } }).SHELL_DATA?.currentUserId;
        if (myUserId && myUserId === payload.user_id && payload.actor_user_id !== myUserId) {
          const roleNames = nextRoles.map((r) => r.name).join(', ');
          const actor = list.find((m) => m.userId === payload.actor_user_id);
          window.dispatchEvent(new CustomEvent('dilla:notify', {
            detail: {
              author: actor?.username || 'admin',
              text: roleNames
                ? `Your roles were updated: ${roleNames}`
                : 'Your roles were cleared',
              duration: 6000,
              kind: 'mention',
              mention: true,
            },
          }));
        }
      },
    );

    // Partial update from PUT /channels/:cid/access — only role_ids changed.
    const unsubAccess = ws.on('channel:access-update', (payload: { channel_id?: string; role_ids?: string[] }) => {
      if (!payload?.channel_id) return;
      const teamStore = useTeamStore.getState();
      for (const [tid, list] of teamStore.channels.entries()) {
        const idx = list.findIndex((c) => c.id === payload.channel_id);
        if (idx < 0) continue;
        const updated: Channel = { ...list[idx], accessRoleIds: payload.role_ids ?? [] };
        const next = list.map((c, i) => (i === idx ? updated : c));
        teamStore.setChannels(tid, next);
        break;
      }
    });

    return () => {
      unsubMsgNew();
      unsubChannelRead();
      unsubChannelUpdated();
      unsubAccess();
      unsubMemberRoles();
    };
  }, [activeTeamId]);

  // Rotate channel encryption keys when a member leaves (kicked/banned).
  useEffect(() => {
    if (!activeTeamId) return;
    const teamId = activeTeamId;

    const unsub = ws.on('member:left', async (payload: { team_id?: string; user_id?: string }) => {
      if (payload?.team_id !== teamId || !payload?.user_id) return;
      const derivedKey = useAuthStore.getState().derivedKey;
      if (!derivedKey) return;

      // Rotate sender keys for all channels the user had access to.
      const teamChannels = useTeamStore.getState().channels.get(teamId) ?? [];
      for (const channel of teamChannels) {
        try {
          const dist = await cryptoService.rotateChannelKey(channel.id, payload.user_id, derivedKey);
          if (dist) {
            // Redistribute new sender key to remaining members via the channel
            await cryptoService.processSenderKey(channel.id, dist, derivedKey);
          }
        } catch {
          // Non-fatal — session may not exist for this channel
        }
      }
      console.log(`[AppLayout] Rotated channel keys after member ${payload.user_id} left team ${teamId}`);
    });

    return () => { unsub(); };
  }, [activeTeamId]);

  // member:joined — server broadcasts this when a new user registers via
  // invite. Append to the local member list so existing sessions don't
  // need a reload to see the joiner.
  useEffect(() => {
    if (!activeTeamId) return;
    const teamId = activeTeamId;
    const unsub = ws.on(
      'member:joined',
      async (payload: { team_id?: string; user?: Record<string, unknown>; member?: Record<string, unknown> }) => {
        if (!payload?.team_id || payload.team_id !== teamId) return;
        const [normalized] = normalizeMembers([
          { member: payload.member ?? {}, user: payload.user ?? {} } as Record<string, unknown>,
        ]);
        if (normalized?.userId) {
          useTeamStore.getState().addMember(teamId, normalized);
        }
        // Re-distribute our sender key for every text channel so the new
        // member can decrypt messages we send from here on. Past messages
        // remain unreadable to them (forward-secret sender keys).
        const derivedKey = useAuthStore.getState().derivedKey;
        if (!derivedKey) return;
        const channels = useTeamStore.getState().channels.get(teamId) ?? [];
        for (const ch of channels) {
          if (ch.type !== 'text') continue;
          try {
            const dist = await cryptoService.getSenderKeyDistribution(ch.id, derivedKey);
            ws.distributeChannelKey(teamId, ch.id, dist);
          } catch (err) {
            console.warn('[useTeamSync] re-distribute sender key failed', ch.id, err);
          }
        }
      },
    );
    return () => { unsub(); };
  }, [activeTeamId]);

  return { authChecked, dataLoaded };
}
