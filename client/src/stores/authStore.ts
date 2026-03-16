import { create } from 'zustand';

export interface TeamEntry {
  token: string;
  user: unknown;
  teamInfo: unknown;
  baseUrl: string;
  serverId?: string;
}

export interface ServerEntry {
  baseUrl: string;
  token: string;
  username: string;
  teamIds: string[];
}

interface AuthState {
  isAuthenticated: boolean;
  /** @deprecated Use derivedKey instead. Kept for legacy migration. */
  passphrase: string | null;
  /** Base64-encoded 32-byte key derived from passkey PRF (or passphrase for legacy) */
  derivedKey: string | null;
  publicKey: string | null;
  credentialIds: string[];
  teams: Map<string, TeamEntry>;
  servers: Map<string, ServerEntry>;

  /** @deprecated Use setDerivedKey instead */
  setPassphrase: (passphrase: string) => void;
  setDerivedKey: (key: string) => void;
  setPublicKey: (key: string) => void;
  setCredentialIds: (ids: string[]) => void;
  addTeam: (teamId: string, token: string, user: unknown, teamInfo: unknown, baseUrl?: string) => void;
  removeTeam: (teamId: string) => void;
  /** Get or create a server entry by baseUrl */
  getOrCreateServer: (baseUrl: string, username?: string) => string;
  /** Update the user object within a team entry */
  updateTeamUser: (teamId: string, userUpdates: Record<string, unknown>) => void;
  /** Update server token (propagates to all teams on that server) */
  setServerToken: (serverId: string, token: string) => void;
  logout: () => void;
}

const TEAMS_STORAGE_KEY = 'dilla_teams';
const SERVERS_STORAGE_KEY = 'dilla_servers';
const DERIVED_KEY_STORAGE_KEY = 'dilla_derived_key';

function persistTeams(teams: Map<string, TeamEntry>) {
  try {
    const obj: Record<string, TeamEntry> = {};
    teams.forEach((v, k) => { obj[k] = v; });
    sessionStorage.setItem(TEAMS_STORAGE_KEY, JSON.stringify(obj));
  } catch { /* ignore */ }
}

function loadPersistedTeams(): Map<string, TeamEntry> {
  try {
    const raw = sessionStorage.getItem(TEAMS_STORAGE_KEY);
    if (!raw) return new Map();
    const obj = JSON.parse(raw) as Record<string, TeamEntry>;
    return new Map(Object.entries(obj));
  } catch {
    return new Map();
  }
}

function persistServers(servers: Map<string, ServerEntry>) {
  try {
    const obj: Record<string, ServerEntry> = {};
    servers.forEach((v, k) => { obj[k] = v; });
    sessionStorage.setItem(SERVERS_STORAGE_KEY, JSON.stringify(obj));
  } catch { /* ignore */ }
}

function loadPersistedServers(): Map<string, ServerEntry> {
  try {
    const raw = sessionStorage.getItem(SERVERS_STORAGE_KEY);
    if (!raw) return new Map();
    const obj = JSON.parse(raw) as Record<string, ServerEntry>;
    return new Map(Object.entries(obj));
  } catch {
    return new Map();
  }
}

/** Derive a stable server ID from a base URL */
function serverIdFromUrl(baseUrl: string): string {
  return baseUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function loadPersistedDerivedKey(): string | null {
  try {
    return sessionStorage.getItem(DERIVED_KEY_STORAGE_KEY);
  } catch {
    return null;
  }
}

const restoredDerivedKey = loadPersistedDerivedKey();

export const useAuthStore = create<AuthState>((set, get) => ({
  isAuthenticated: restoredDerivedKey !== null,
  passphrase: restoredDerivedKey,
  derivedKey: restoredDerivedKey,
  publicKey: null,
  credentialIds: [],
  teams: loadPersistedTeams(),
  servers: loadPersistedServers(),

  setPassphrase: (passphrase: string) => {
    try { sessionStorage.setItem(DERIVED_KEY_STORAGE_KEY, passphrase); } catch { /* ignore */ }
    set({ passphrase, derivedKey: passphrase, isAuthenticated: true });
  },

  setDerivedKey: (key: string) => {
    try { sessionStorage.setItem(DERIVED_KEY_STORAGE_KEY, key); } catch { /* ignore */ }
    set({ derivedKey: key, passphrase: key, isAuthenticated: true });
  },

  setPublicKey: (key: string) => set({ publicKey: key }),

  setCredentialIds: (ids: string[]) => set({ credentialIds: ids }),

  addTeam: (teamId: string, token: string, user: unknown, teamInfo: unknown, baseUrl?: string) =>
    set((state) => {
      const teams = new Map(state.teams);
      const servers = new Map(state.servers);
      const url = baseUrl ?? '';
      const serverId = url ? serverIdFromUrl(url) : '';

      // Auto-create/update server entry
      if (serverId) {
        const existing = servers.get(serverId);
        const teamIds = existing?.teamIds ?? [];
        if (!teamIds.includes(teamId)) teamIds.push(teamId);
        servers.set(serverId, {
          baseUrl: url,
          token,
          username: existing?.username ?? '',
          teamIds,
        });
        persistServers(servers);
      }

      teams.set(teamId, { token, user, teamInfo, baseUrl: url, serverId });
      persistTeams(teams);
      return { teams, servers };
    }),

  removeTeam: (teamId: string) =>
    set((state) => {
      const teams = new Map(state.teams);
      const servers = new Map(state.servers);
      const entry = teams.get(teamId);
      teams.delete(teamId);

      // Remove team from server's teamIds
      if (entry?.serverId) {
        const server = servers.get(entry.serverId);
        if (server) {
          server.teamIds = server.teamIds.filter(id => id !== teamId);
          if (server.teamIds.length === 0) {
            servers.delete(entry.serverId);
          } else {
            servers.set(entry.serverId, server);
          }
          persistServers(servers);
        }
      }

      persistTeams(teams);
      return { teams, servers };
    }),

  getOrCreateServer: (baseUrl: string, username?: string): string => {
    const serverId = serverIdFromUrl(baseUrl);
    const state = get();
    const servers = new Map(state.servers);
    if (!servers.has(serverId)) {
      servers.set(serverId, {
        baseUrl,
        token: '',
        username: username ?? '',
        teamIds: [],
      });
      persistServers(servers);
      set({ servers });
    } else if (username) {
      const server = servers.get(serverId)!;
      server.username = username;
      servers.set(serverId, server);
      persistServers(servers);
      set({ servers });
    }
    return serverId;
  },

  updateTeamUser: (teamId: string, userUpdates: Record<string, unknown>) =>
    set((state) => {
      const teams = new Map(state.teams);
      const entry = teams.get(teamId);
      if (!entry) return {};
      teams.set(teamId, { ...entry, user: { ...(entry.user as Record<string, unknown>), ...userUpdates } });
      persistTeams(teams);
      return { teams };
    }),

  setServerToken: (serverId: string, token: string) =>
    set((state) => {
      const servers = new Map(state.servers);
      const server = servers.get(serverId);
      if (!server) return {};
      server.token = token;
      servers.set(serverId, server);

      // Propagate to all teams on this server
      const teams = new Map(state.teams);
      for (const teamId of server.teamIds) {
        const team = teams.get(teamId);
        if (team) {
          teams.set(teamId, { ...team, token });
        }
      }

      persistServers(servers);
      persistTeams(teams);
      return { servers, teams };
    }),

  logout: () => {
    sessionStorage.removeItem(TEAMS_STORAGE_KEY);
    sessionStorage.removeItem(SERVERS_STORAGE_KEY);
    sessionStorage.removeItem(DERIVED_KEY_STORAGE_KEY);
    set({
      isAuthenticated: false,
      passphrase: null,
      derivedKey: null,
      publicKey: null,
      credentialIds: [],
      teams: new Map(),
      servers: new Map(),
    });
  },
}));
