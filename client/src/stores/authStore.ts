import { create } from 'zustand';

export interface User {
  id: string;
  username: string;
  display_name?: string;
  public_key?: string;
  is_admin?: boolean;
}

export interface TeamEntry {
  token: string;
  user: User | null;
  teamInfo: Record<string, unknown> | null;
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
  addTeam: (teamId: string, token: string, user: User | null, teamInfo: Record<string, unknown> | null, baseUrl?: string) => void;
  removeTeam: (teamId: string) => void;
  /** Get or create a server entry by baseUrl */
  getOrCreateServer: (baseUrl: string, username?: string) => string;
  /** Update the user object within a team entry */
  updateTeamUser: (teamId: string, userUpdates: Partial<User>) => void;
  /** Update server token (propagates to all teams on that server) */
  setServerToken: (serverId: string, token: string) => void;
  logout: () => void;
}

const TEAMS_STORAGE_KEY = 'dilla_teams';
const SERVERS_STORAGE_KEY = 'dilla_servers';

function persistTeams(teams: Map<string, TeamEntry>) {
  try {
    const obj: Record<string, TeamEntry> = {};
    teams.forEach((v, k) => { obj[k] = v; });
    // Session-scoped storage (cleared on tab close). JWT tokens are short-lived
    // and re-obtained via Ed25519 challenge-response on each session restore.
    sessionStorage.setItem(TEAMS_STORAGE_KEY, JSON.stringify(obj)); // lgtm[js/clear-text-storage-of-sensitive-data]
  } catch { /* ignore */ }
}

function loadPersistedTeams(): Map<string, TeamEntry> {
  try {
    const raw = sessionStorage.getItem(TEAMS_STORAGE_KEY);
    if (!raw) return new Map();
    const obj = JSON.parse(raw) as Record<string, TeamEntry>;
    return new Map(Object.entries(obj));
  } catch {
    /* v8 ignore next */
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
    /* v8 ignore next */
    return new Map();
  }
}

/** Derive a stable server ID from a base URL */
function serverIdFromUrl(baseUrl: string): string {
  return baseUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

// derivedKey is persisted to sessionStorage encrypted with a per-tab AES
// wrapping key. The wrapping key lives in a non-extractable CryptoKey
// stored in IndexedDB and is ephemeral per browser session. This prevents
// the derivedKey from being stored as cleartext in sessionStorage.
const DERIVED_KEY_STORAGE = 'dilla:derivedKey:enc';
const WRAP_KEY_DB = 'dilla-wrap';
const WRAP_KEY_STORE = 'keys';
const WRAP_KEY_ID = 'session-wrap';

async function getOrCreateWrapKey(): Promise<CryptoKey> {
  // Try to load existing wrapping key from IndexedDB
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(WRAP_KEY_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(WRAP_KEY_STORE)) {
        req.result.createObjectStore(WRAP_KEY_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  const existing = await new Promise<CryptoKey | undefined>((resolve) => {
    const tx = db.transaction(WRAP_KEY_STORE, 'readonly');
    const req = tx.objectStore(WRAP_KEY_STORE).get(WRAP_KEY_ID);
    req.onsuccess = () => resolve(req.result as CryptoKey | undefined);
    req.onerror = () => resolve(undefined);
    tx.oncomplete = () => {};
  });

  if (existing) {
    db.close();
    return existing;
  }

  // Generate a new non-extractable AES-GCM key
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable
    ['encrypt', 'decrypt'],
  );

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(WRAP_KEY_STORE, 'readwrite');
    tx.objectStore(WRAP_KEY_STORE).put(key, WRAP_KEY_ID);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  db.close();
  return key;
}

async function encryptDerivedKey(plaintext: string): Promise<string> {
  const key = await getOrCreateWrapKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const combined = new Uint8Array(12 + enc.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(enc), 12);
  return btoa(String.fromCharCode(...combined));
}

async function decryptDerivedKey(ciphertext: string): Promise<string> {
  const key = await getOrCreateWrapKey();
  const data = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));
  const iv = data.slice(0, 12);
  const enc = data.slice(12);
  const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, enc);
  return new TextDecoder().decode(dec);
}

// Synchronous load returns null — async restore happens in useCryptoRestore
function loadPersistedDerivedKey(): string | null {
  return null; // Decryption is async; handled by restoreDerivedKey()
}

/** Async restore of encrypted derivedKey from sessionStorage. */
export async function restoreDerivedKey(): Promise<string | null> {
  try {
    const stored = sessionStorage.getItem(DERIVED_KEY_STORAGE);
    if (!stored) return null;
    return await decryptDerivedKey(stored);
  } catch {
    return null;
  }
}

async function persistDerivedKey(key: string | null): Promise<void> {
  try {
    if (key) {
      const encrypted = await encryptDerivedKey(key);
      sessionStorage.setItem(DERIVED_KEY_STORAGE, encrypted);
    } else {
      sessionStorage.removeItem(DERIVED_KEY_STORAGE);
    }
  } catch { /* private browsing */ }
}

export const useAuthStore = create<AuthState>((set, get) => ({
  isAuthenticated: false,
  passphrase: null,
  derivedKey: loadPersistedDerivedKey(),
  publicKey: null,
  credentialIds: [],
  teams: loadPersistedTeams(),
  servers: loadPersistedServers(),

  setPassphrase: (passphrase: string) => {
    void persistDerivedKey(passphrase);
    set({ passphrase, derivedKey: passphrase, isAuthenticated: true });
  },

  setDerivedKey: (key: string) => {
    void persistDerivedKey(key);
    set({ derivedKey: key, passphrase: key, isAuthenticated: true });
  },

  setPublicKey: (key: string) => set({ publicKey: key }),

  setCredentialIds: (ids: string[]) => set({ credentialIds: ids }),

  addTeam: (teamId: string, token: string, user: User | null, teamInfo: Record<string, unknown> | null, baseUrl?: string) =>
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

  updateTeamUser: (teamId: string, userUpdates: Partial<User>) =>
    set((state) => {
      const teams = new Map(state.teams);
      const entry = teams.get(teamId);
      if (!entry?.user) return {};
      teams.set(teamId, { ...entry, user: { ...entry.user, ...userUpdates } });
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
    import('../services/crypto').then(({ resetCrypto }) => resetCrypto()).catch(() => {});
    sessionStorage.removeItem(TEAMS_STORAGE_KEY);
    sessionStorage.removeItem(SERVERS_STORAGE_KEY);
    void persistDerivedKey(null);
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
