import type { User } from '../stores/authStore';
import { fetchWithTimeout } from './fetchWithTimeout';

/**
 * H-13d: returns true when `baseUrl`'s origin matches the page's
 * own origin AND the page is on a real-network protocol (http/https).
 *
 * When true, the `__dilla_jwt` cookie set by `/auth/verify` will
 * travel automatically on subsequent fetches, so we can safely drop
 * the manual `Authorization: Bearer` header — eliminating the JS-
 * reachable JWT surface for any XSS that lands in the SPA.
 *
 * Returns false for:
 *   - Cross-origin requests (cross-team flows targeting a different
 *     baseUrl than the page's origin).
 *   - Tauri desktop, where the page loads from `tauri://localhost`
 *     (or platform equivalent) and doesn't share a cookie jar with
 *     the https:// API origin.
 *   - Unparseable URLs / SSR contexts (no globalThis.location).
 */
export function isSameOriginAsApi(baseUrl: string): boolean {
  try {
    const pageOrigin = globalThis.location?.origin ?? '';
    if (!pageOrigin) return false;
    // Tauri's custom protocol (tauri:, app:, asset:, http://tauri.localhost
    // on Windows, etc.) doesn't share a cookie jar with the API's
    // https:// origin even when baseUrl looks the same.
    if (pageOrigin.startsWith('tauri:') || pageOrigin.startsWith('app:')) {
      return false;
    }
    // Same-origin relative URL (baseUrl is empty string or starts with /)
    // → definitely same origin.
    if (!baseUrl || baseUrl.startsWith('/')) return true;
    const apiOrigin = new URL(baseUrl).origin;
    return apiOrigin === pageOrigin;
  } catch {
    return false;
  }
}

export interface VoicePeer {
  user_id: string;
  username: string;
  muted: boolean;
  deafened: boolean;
  speaking: boolean;
  voiceLevel: number;
  screen_sharing?: boolean;
  webcam_sharing?: boolean;
}

export interface VoiceState {
  channel_id: string;
  peers: VoicePeer[];
}

export interface UserPresence {
  user_id: string;
  status: 'online' | 'idle' | 'dnd' | 'offline';
  custom_status: string;
  last_active: string;
}

export interface ReactionGroup {
  emoji: string;
  count: number;
  users: string[];
  me: boolean;
}

export interface Attachment {
  id: string;
  message_id: string;
  filename: string;
  content_type: string;
  size: number;
  url: string;
}

interface TeamConnection {
  baseUrl: string;
  token: string | null;
  teamId: string;
}

class ApiService {
  private readonly connections: Map<string, TeamConnection> = new Map();
  private onAuthError: (() => void) | null = null;

  setAuthErrorHandler(handler: () => void): void {
    this.onAuthError = handler;
  }

  addTeam(teamId: string, baseUrl: string): void {
    this.connections.set(teamId, { baseUrl, token: null, teamId });
  }

  removeTeam(teamId: string): void {
    this.connections.delete(teamId);
  }

  setToken(teamId: string, token: string): void {
    const conn = this.connections.get(teamId);
    if (conn) {
      conn.token = token;
    }
  }

  private getConnection(teamId: string): TeamConnection {
    const conn = this.connections.get(teamId);
    if (!conn) throw new Error(`Not connected to team ${teamId}`);
    return conn;
  }

  getConnectionInfo(teamId: string): { baseUrl: string; token: string | null } | null {
    const conn = this.connections.get(teamId);
    if (!conn) return null;
    return { baseUrl: conn.baseUrl, token: conn.token };
  }

  private async request<T>(
    baseUrl: string,
    path: string,
    options: RequestInit = {},
    token?: string | null,
  ): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    };
    // H-13d: drop the bearer header when the cookie is guaranteed to
    // travel (same-origin SPA on the rust-embed-served origin).
    // Keep the bearer for cross-origin (cross-team requests hitting
    // a different baseUrl, and Tauri where the page origin is a
    // custom protocol like tauri://localhost that doesn't share a
    // cookie jar with the https:// API origin).
    if (token && !isSameOriginAsApi(baseUrl)) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    // H-13b.1: send the httpOnly __dilla_jwt cookie. Server's
    // auth_middleware prefers the header when both are present.
    const res = await fetchWithTimeout(`${baseUrl}${path}`, { ...options, headers, credentials: 'include', timeout: 15000 });
    if (!res.ok) {
      // Only trigger auth error for authenticated requests (bearer token was sent).
      // Public endpoints like /auth/verify return 401 for bad credentials — that's
      // not an expired-token situation and must NOT redirect to login.
      if (res.status === 401 && this.onAuthError && token) {
        this.onAuthError();
      }
      const body = await res.text();
      let message = body;
      try {
        const json = JSON.parse(body);
        if (json.error) message = json.error;
      } catch { /* not JSON */ }
      throw new Error(message || `Server returned ${res.status}`);
    }
    return res.json() as Promise<T>;
  }

  /** Unwrap server responses that wrap arrays in {key: [...]} */
  private unwrapArray(data: unknown, key: string): unknown[] {
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object' && key in data) {
      const val = (data as Record<string, unknown>)[key];
      if (Array.isArray(val)) return val;
    }
    return [];
  }

  /** Unwrap server responses that wrap objects in {key: {...}} */
  private unwrapObject(data: unknown, key: string): unknown {
    if (data && typeof data === 'object' && key in data) {
      return (data as Record<string, unknown>)[key];
    }
    return data;
  }

  // Auth endpoints
  async requestChallenge(
    teamId: string,
    publicKey: string,
  ): Promise<{ challenge_id: string; nonce: string }> {
    const conn = this.getConnection(teamId);
    return this.request(conn.baseUrl, '/api/v1/auth/challenge', {
      method: 'POST',
      body: JSON.stringify({ public_key: publicKey }),
    });
  }

  async verifyChallenge(
    teamId: string,
    challengeId: string,
    publicKey: string,
    signature: string,
  ): Promise<{ token: string; user: User }> {
    const conn = this.getConnection(teamId);
    return this.request(conn.baseUrl, '/api/v1/auth/verify', {
      method: 'POST',
      body: JSON.stringify({
        challenge_id: challengeId,
        public_key: publicKey,
        signature,
      }),
    });
  }

  async register(
    teamId: string,
    challengeId: string,
    publicKey: string,
    signature: string,
    username: string,
    inviteToken: string,
  ): Promise<{ user: User; token: string }> {
    const conn = this.getConnection(teamId);
    return this.request(conn.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        challenge_id: challengeId,
        public_key: publicKey,
        signature,
        username,
        invite_token: inviteToken,
      }),
    });
  }

  async bootstrap(
    teamId: string,
    challengeId: string,
    publicKey: string,
    signature: string,
    username: string,
    bootstrapToken: string,
    teamName?: string,
  ): Promise<{ user: User; token: string; team: Record<string, unknown> }> {
    const conn = this.getConnection(teamId);
    return this.request(conn.baseUrl, '/api/v1/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify({
        challenge_id: challengeId,
        public_key: publicKey,
        signature,
        username,
        bootstrap_token: bootstrapToken,
        team_name: teamName || undefined,
      }),
    });
  }

  /** Request a short-lived, single-use WebSocket ticket (preferred over passing JWT in URL). */
  async getWsTicket(teamId: string): Promise<string> {
    const conn = this.getConnection(teamId);
    const result = await this.request<{ ticket: string }>(
      conn.baseUrl, '/api/v1/auth/ws-ticket', { method: 'POST' }, conn.token,
    );
    return result.ticket;
  }

  /**
   * F5 — Revoke the caller's bearer JWT on the server. Backed by
   * server-side `POST /api/v1/auth/logout` (added in step 5 H2). The
   * server inserts the jti into the `jwt_revocations` table so any
   * stolen copy of the token becomes unusable immediately.
   *
   * Calls per server (NOT per team) — a single revocation invalidates
   * the token for every team on that server. The caller is responsible
   * for clearing local state afterwards.
   *
   * Returns `true` on confirmed server-side revocation, `false` if the
   * server was unreachable (call site warns the user). Never throws.
   */
  async logoutServer(baseUrl: string, token: string): Promise<boolean> {
    try {
      await this.request(baseUrl, '/api/v1/auth/logout', { method: 'POST' }, token);
      return true;
    } catch {
      return false;
    }
  }

  // User profile
  async getMe(baseUrl: string, token: string): Promise<unknown> {
    const data = await this.request(baseUrl, '/api/v1/users/me', { method: 'GET' }, token);
    return this.unwrapObject(data, 'user');
  }

  async updateMe(
    baseUrl: string,
    token: string,
    updates: {
      display_name?: string;
      avatar_url?: string;
      status_text?: string;
      status_type?: string;
      quiet_hours_enabled?: boolean;
      quiet_hours_from?: string;
      quiet_hours_to?: string;
    },
  ): Promise<unknown> {
    const data = await this.request(
      baseUrl,
      '/api/v1/users/me',
      { method: 'PATCH', body: JSON.stringify(updates) },
      token,
    );
    return this.unwrapObject(data, 'user');
  }

  // Invite endpoints
  async createInvite(
    teamId: string,
    maxUses?: number,
    expiresInHours?: number,
  ): Promise<unknown> {
    const conn = this.getConnection(teamId);
    return this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/invites`,
      {
        method: 'POST',
        body: JSON.stringify({ max_uses: maxUses, expires_in_hours: expiresInHours }),
      },
      conn.token,
    );
  }

  async listInvites(teamId: string): Promise<unknown[]> {
    const conn = this.getConnection(teamId);
    const data = await this.request(conn.baseUrl, `/api/v1/teams/${teamId}/invites`, { method: 'GET' }, conn.token);
    return this.unwrapArray(data, 'invites');
  }

  async revokeInvite(teamId: string, inviteId: string): Promise<void> {
    const conn = this.getConnection(teamId);
    await this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/invites/${inviteId}`,
      { method: 'DELETE' },
      conn.token,
    );
  }

  async getInviteInfo(baseUrl: string, token: string): Promise<unknown> {
    return this.request(baseUrl, `/api/v1/invites/${token}/info`, { method: 'GET' });
  }

  // Team
  async listTeams(baseUrl: string, token: string): Promise<Record<string, unknown>[]> {
    const data = await this.request(baseUrl, '/api/v1/teams', { method: 'GET' }, token);
    return this.unwrapArray(data, 'teams') as Record<string, unknown>[];
  }

  async createTeam(baseUrl: string, token: string, name: string, description?: string): Promise<unknown> {
    const data = await this.request(
      baseUrl,
      '/api/v1/teams',
      { method: 'POST', body: JSON.stringify({ name, description: description ?? '' }) },
      token,
    );
    return this.unwrapObject(data, 'team');
  }

  async getTeam(teamId: string): Promise<unknown> {
    const conn = this.getConnection(teamId);
    const data = await this.request(conn.baseUrl, `/api/v1/teams/${teamId}`, { method: 'GET' }, conn.token);
    return this.unwrapObject(data, 'team');
  }

  async updateTeam(teamId: string, updates: Record<string, unknown>): Promise<unknown> {
    const conn = this.getConnection(teamId);
    return this.request(
      conn.baseUrl,
      '/api/v1/teams/' + teamId,
      { method: 'PATCH', body: JSON.stringify(updates) },
      conn.token,
    );
  }

  // Channels
  async getChannels(teamId: string): Promise<unknown[]> {
    const conn = this.getConnection(teamId);
    const data = await this.request(conn.baseUrl, `/api/v1/teams/${teamId}/channels`, { method: 'GET' }, conn.token);
    return this.unwrapArray(data, 'channels');
  }

  async createChannel(
    teamId: string,
    data: { name: string; type: string; topic?: string; category?: string },
  ): Promise<unknown> {
    const conn = this.getConnection(teamId);
    return this.request(
      conn.baseUrl,
      '/api/v1/teams/' + teamId + '/channels',
      { method: 'POST', body: JSON.stringify(data) },
      conn.token,
    );
  }

  async updateChannel(
    teamId: string,
    channelId: string,
    updates: Record<string, unknown>,
  ): Promise<unknown> {
    const conn = this.getConnection(teamId);
    return this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/channels/${channelId}`,
      { method: 'PATCH', body: JSON.stringify(updates) },
      conn.token,
    );
  }


  async setChannelAccess(teamId: string, channelId: string, roleIds: string[]): Promise<{ role_ids: string[] }> {
    const conn = this.getConnection(teamId);
    return this.request<{ role_ids: string[] }>(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/channels/${channelId}/access`,
      { method: 'PUT', body: JSON.stringify({ role_ids: roleIds }) },
      conn.token,
    );
  }

  // Channel groups — first-class entities that own permissions; channels
  // inherit the group's access list (pure inheritance, see migration 020).
  async listGroups(teamId: string): Promise<Array<{ id: string; name: string; position: number; access_role_ids: string[] }>> {
    const conn = this.getConnection(teamId);
    const data = await this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/groups`,
      { method: 'GET' },
      conn.token,
    );
    return (Array.isArray(data) ? data : []) as Array<{ id: string; name: string; position: number; access_role_ids: string[] }>;
  }
  async createGroup(teamId: string, name: string): Promise<{ id: string; name: string; position: number }> {
    const conn = this.getConnection(teamId);
    return this.request<{ id: string; name: string; position: number }>(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/groups`,
      { method: 'POST', body: JSON.stringify({ name }) },
      conn.token,
    );
  }
  async updateGroup(teamId: string, groupId: string, body: { name?: string; position?: number }): Promise<{ id: string; name: string; position: number }> {
    const conn = this.getConnection(teamId);
    return this.request<{ id: string; name: string; position: number }>(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/groups/${groupId}`,
      { method: 'PUT', body: JSON.stringify(body) },
      conn.token,
    );
  }
  async deleteGroup(teamId: string, groupId: string): Promise<void> {
    const conn = this.getConnection(teamId);
    await this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/groups/${groupId}`,
      { method: 'DELETE' },
      conn.token,
    );
  }
  async setGroupAccess(teamId: string, groupId: string, roleIds: string[], hiddenIfRestricted?: boolean): Promise<{ role_ids: string[]; hidden_if_restricted: boolean }> {
    const conn = this.getConnection(teamId);
    const body: Record<string, unknown> = { role_ids: roleIds };
    if (hiddenIfRestricted !== undefined) body.hidden_if_restricted = hiddenIfRestricted;
    return this.request<{ role_ids: string[]; hidden_if_restricted: boolean }>(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/groups/${groupId}/access`,
      { method: 'PUT', body: JSON.stringify(body) },
      conn.token,
    );
  }

  async deleteChannel(teamId: string, channelId: string): Promise<void> {
    const conn = this.getConnection(teamId);
    await this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/channels/${channelId}`,
      { method: 'DELETE' },
      conn.token,
    );
  }

  // Members
  async getMembers(teamId: string): Promise<unknown[]> {
    const conn = this.getConnection(teamId);
    const data = await this.request(conn.baseUrl, `/api/v1/teams/${teamId}/members`, { method: 'GET' }, conn.token);
    return this.unwrapArray(data, 'members');
  }

  async updateMember(
    teamId: string,
    userId: string,
    updates: { nickname?: string; role_ids?: string[] },
  ): Promise<void> {
    const conn = this.getConnection(teamId);
    await this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/members/${userId}`,
      { method: 'PATCH', body: JSON.stringify(updates) },
      conn.token,
    );
  }

  async kickMember(teamId: string, userId: string): Promise<void> {
    const conn = this.getConnection(teamId);
    await this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/members/${userId}`,
      { method: 'DELETE' },
      conn.token,
    );
  }

  async banMember(teamId: string, userId: string): Promise<void> {
    const conn = this.getConnection(teamId);
    await this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/members/${userId}/ban`,
      { method: 'POST' },
      conn.token,
    );
  }

  async unbanMember(teamId: string, userId: string): Promise<void> {
    const conn = this.getConnection(teamId);
    await this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/members/${userId}/ban`,
      { method: 'DELETE' },
      conn.token,
    );
  }

  // Roles
  async getRoles(teamId: string): Promise<unknown[]> {
    const conn = this.getConnection(teamId);
    const data = await this.request(conn.baseUrl, `/api/v1/teams/${teamId}/roles`, { method: 'GET' }, conn.token);
    return this.unwrapArray(data, 'roles');
  }

  async createRole(
    teamId: string,
    data: { name: string; color: string; permissions: number },
  ): Promise<unknown> {
    const conn = this.getConnection(teamId);
    return this.request(
      conn.baseUrl,
      '/api/v1/teams/' + teamId + '/roles',
      { method: 'POST', body: JSON.stringify(data) },
      conn.token,
    );
  }

  async updateRole(
    teamId: string,
    roleId: string,
    updates: Record<string, unknown>,
  ): Promise<unknown> {
    const conn = this.getConnection(teamId);
    return this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/roles/${roleId}`,
      { method: 'PATCH', body: JSON.stringify(updates) },
      conn.token,
    );
  }

  async deleteRole(teamId: string, roleId: string): Promise<void> {
    const conn = this.getConnection(teamId);
    await this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/roles/${roleId}`,
      { method: 'DELETE' },
      conn.token,
    );
  }

  // Polls — server-tracked interactive polls. The /poll slash command
  // creates one and the kind:'poll' message renderer reads its state.
  async getPolls(teamId: string, channelId: string): Promise<unknown[]> {
    const conn = this.getConnection(teamId);
    const data = await this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/channels/${channelId}/polls`,
      { method: 'GET' },
      conn.token,
    );
    return this.unwrapArray(data, 'polls');
  }

  async createPoll(
    teamId: string,
    channelId: string,
    body: { question: string; options: string[] },
  ): Promise<unknown> {
    const conn = this.getConnection(teamId);
    return this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/channels/${channelId}/polls`,
      { method: 'POST', body: JSON.stringify(body) },
      conn.token,
    );
  }

  async votePoll(teamId: string, pollId: string, optionIndex: number): Promise<unknown> {
    const conn = this.getConnection(teamId);
    return this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/polls/${pollId}/votes`,
      { method: 'POST', body: JSON.stringify({ option_index: optionIndex }) },
      conn.token,
    );
  }

  async unvotePoll(teamId: string, pollId: string): Promise<unknown> {
    const conn = this.getConnection(teamId);
    return this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/polls/${pollId}/votes`,
      { method: 'DELETE' },
      conn.token,
    );
  }

  /** The caller voluntarily leaves the team. Server enforces a sole-admin
   *  guard and responds with 409 if the user is the only admin. */
  async leaveTeam(teamId: string): Promise<void> {
    const conn = this.getConnection(teamId);
    await this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/leave`,
      { method: 'POST' },
      conn.token,
    );
  }

  /** Mark a channel as read up to its current head. Server persists
   *  the read-cursor so the unread count stays at zero across
   *  reloads + other devices. Best-effort: callers should still
   *  update the local unread store regardless of the response. */
  async markChannelRead(teamId: string, channelId: string): Promise<void> {
    const conn = this.getConnection(teamId);
    await this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/channels/${channelId}/read`,
      { method: 'PUT' },
      conn.token,
    );
  }

  /** H-14: list this user's enrolled devices. Each entry carries the
   *  device label, last-seen risk signals (IP / UA / country),
   *  creation + revocation timestamps. */
  async listDevices(teamId: string): Promise<Array<Record<string, unknown>>> {
    const conn = this.getConnection(teamId);
    const data = await this.request(
      conn.baseUrl,
      `/api/v1/devices`,
      { method: 'GET' },
      conn.token,
    );
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).devices)) {
      return (data as Record<string, unknown>).devices as Array<Record<string, unknown>>;
    }
    return [];
  }

  /** H-14: revoke a device by id. Server refuses to revoke the
   *  user's last active device (returns a 400) — UI surfaces that
   *  to the caller as a thrown error. */
  async revokeDevice(teamId: string, deviceId: string): Promise<void> {
    const conn = this.getConnection(teamId);
    await this.request(
      conn.baseUrl,
      `/api/v1/devices/${deviceId}/revoke`,
      { method: 'POST' },
      conn.token,
    );
  }

  /** User-id list of everyone the caller has blocked. */
  async listBlocks(teamId: string): Promise<string[]> {
    const conn = this.getConnection(teamId);
    const data = await this.request<{ user_ids?: string[] }>(
      conn.baseUrl,
      `/api/v1/users/me/blocks`,
      { method: 'GET' },
      conn.token,
    );
    return Array.isArray(data?.user_ids) ? data.user_ids : [];
  }
  async blockUser(teamId: string, blockedId: string): Promise<void> {
    const conn = this.getConnection(teamId);
    await this.request(
      conn.baseUrl,
      `/api/v1/users/me/blocks/${blockedId}`,
      { method: 'POST' },
      conn.token,
    );
  }
  async unblockUser(teamId: string, blockedId: string): Promise<void> {
    const conn = this.getConnection(teamId);
    await this.request(
      conn.baseUrl,
      `/api/v1/users/me/blocks/${blockedId}`,
      { method: 'DELETE' },
      conn.token,
    );
  }

  async pinMessage(teamId: string, channelId: string, messageId: string): Promise<void> {
    const conn = this.getConnection(teamId);
    await this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/channels/${channelId}/messages/${messageId}/pin`,
      { method: 'POST' },
      conn.token,
    );
  }
  async unpinMessage(teamId: string, channelId: string, messageId: string): Promise<void> {
    const conn = this.getConnection(teamId);
    await this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/channels/${channelId}/messages/${messageId}/pin`,
      { method: 'DELETE' },
      conn.token,
    );
  }

  /** Resolve a gif URL via the server-side `/giphy` proxy. The server holds
   *  the Giphy API key (DILLA_GIPHY_API_KEY) so it never reaches the bundle.
   *  Returns `{ url, query }` on success. Throws when the key is unset
   *  (503) or no gif matches (404). */
  async searchGif(teamId: string, query: string, limit?: number): Promise<{ url: string; query: string; results?: Array<{ url: string; preview: string }> }> {
    const conn = this.getConnection(teamId);
    const q = `q=${encodeURIComponent(query)}` + (limit ? `&limit=${limit}` : '');
    return this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/gif?${q}`,
      { method: 'GET' },
      conn.token,
    ) as Promise<{ url: string; query: string; results?: Array<{ url: string; preview: string }> }>;
  }

  /** Materialize a picked Giphy URL into a team attachment so the gif
   *  is served from /attachments instead of media.giphy.com — keeps
   *  viewer IPs off Giphy and the asset doesn't rot when Giphy
   *  rotates URLs. Returns the same shape uploadFile returns. */
  async embedGif(teamId: string, url: string): Promise<Attachment> {
    const conn = this.getConnection(teamId);
    return this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/gif/embed`,
      { method: 'POST', body: JSON.stringify({ url }) },
      conn.token,
    ) as Promise<Attachment>;
  }

  /** Returns whether the team has a Giphy API key on file. The key
   *  itself never crosses the wire — admins set it via setGiphyApiKey. */
  async getGiphyIntegration(teamId: string): Promise<{ configured: boolean }> {
    const conn = this.getConnection(teamId);
    return this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/integrations/giphy`,
      { method: 'GET' },
      conn.token,
    ) as Promise<{ configured: boolean }>;
  }

  /** Store (or clear, when apiKey is empty) the team's Giphy API key.
   *  Requires admin permission server-side. */
  async setGiphyApiKey(teamId: string, apiKey: string): Promise<{ configured: boolean }> {
    const conn = this.getConnection(teamId);
    return this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/integrations/giphy`,
      { method: 'PUT', body: JSON.stringify({ api_key: apiKey }) },
      conn.token,
    ) as Promise<{ configured: boolean }>;
  }

  /** Mute a channel for the current user. `mutedUntil` is an ISO string;
   *  omit to mute indefinitely. */
  async muteChannel(teamId: string, channelId: string, mutedUntil?: string | null): Promise<unknown> {
    const conn = this.getConnection(teamId);
    return this.request(
      conn.baseUrl,
      `/api/v1/me/muted-channels/${channelId}`,
      { method: 'PUT', body: JSON.stringify({ muted_until: mutedUntil ?? null }) },
      conn.token,
    );
  }

  async unmuteChannel(teamId: string, channelId: string): Promise<void> {
    const conn = this.getConnection(teamId);
    await this.request(
      conn.baseUrl,
      `/api/v1/me/muted-channels/${channelId}`,
      { method: 'DELETE' },
      conn.token,
    );
  }

  async getAuditEvents(teamId: string, limit?: number): Promise<unknown[]> {
    const conn = this.getConnection(teamId);
    const qs = limit ? `?limit=${limit}` : '';
    const data = await this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/audit${qs}`,
      { method: 'GET' },
      conn.token,
    );
    return this.unwrapArray(data, 'audit_events');
  }

  /** Reorder roles. Pass role_ids ordered LOW position → HIGH position
   *  (server assigns `position = index`). */
  async reorderRoles(teamId: string, roleIds: string[]): Promise<unknown> {
    const conn = this.getConnection(teamId);
    return this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/roles/reorder`,
      { method: 'PUT', body: JSON.stringify({ role_ids: roleIds }) },
      conn.token,
    );
  }

  // Messages
  async getMessages(
    teamId: string,
    channelId: string,
    limit?: number,
    before?: string,
  ): Promise<unknown[]> {
    const conn = this.getConnection(teamId);
    const params = new URLSearchParams();
    if (limit != null) params.set('limit', String(limit));
    if (before) params.set('before', before);
    const qs = params.toString();
    const suffix = qs ? `?${qs}` : '';
    const path = `/api/v1/teams/${teamId}/channels/${channelId}/messages${suffix}`;
    const data = await this.request(conn.baseUrl, path, { method: 'GET' }, conn.token);
    return this.unwrapArray(data, 'messages');
  }

  // Federation
  async getFederationStatus(teamId: string): Promise<{
    node_name: string;
    peers: Array<{ name: string; address: string; status: string; last_seen: string }>;
    lamport_ts: number;
  }> {
    const conn = this.getConnection(teamId);
    return this.request(
      conn.baseUrl,
      `/api/v1/federation/status`,
      { method: 'GET' },
      conn.token,
    );
  }

  async getFederationPeers(teamId: string): Promise<
    Array<{ name: string; address: string; status: string; last_seen: string }>
  > {
    const conn = this.getConnection(teamId);
    return this.request(
      conn.baseUrl,
      `/api/v1/federation/peers`,
      { method: 'GET' },
      conn.token,
    );
  }

  async generateJoinToken(teamId: string): Promise<{
    token: string;
    join_command: string;
  }> {
    const conn = this.getConnection(teamId);
    return this.request(
      conn.baseUrl,
      `/api/v1/federation/join-token`,
      { method: 'POST' },
      conn.token,
    );
  }

  // Direct Messages
  async createDM(teamId: string, memberIds: string[]): Promise<unknown> {
    const conn = this.getConnection(teamId);
    return this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/dms`,
      { method: 'POST', body: JSON.stringify({ user_ids: memberIds }) },
      conn.token,
    );
  }

  async getDMChannels(teamId: string): Promise<unknown[]> {
    const conn = this.getConnection(teamId);
    const data = await this.request(conn.baseUrl, `/api/v1/teams/${teamId}/dms`, { method: 'GET' }, conn.token);
    return this.unwrapArray(data, 'channels');
  }

  async getDMChannel(teamId: string, dmId: string): Promise<unknown> {
    const conn = this.getConnection(teamId);
    const data = await this.request(conn.baseUrl, `/api/v1/teams/${teamId}/dms/${dmId}`, { method: 'GET' }, conn.token);
    return this.unwrapObject(data, 'channel');
  }

  async sendDMMessage(teamId: string, dmId: string, content: string): Promise<unknown> {
    const conn = this.getConnection(teamId);
    return this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/dms/${dmId}/messages`,
      { method: 'POST', body: JSON.stringify({ content }) },
      conn.token,
    );
  }

  async getDMMessages(teamId: string, dmId: string, before?: string, limit?: number): Promise<unknown[]> {
    const conn = this.getConnection(teamId);
    const params = new URLSearchParams();
    if (before) params.set('before', before);
    if (limit != null) params.set('limit', String(limit));
    const qs = params.toString();
    const dmSuffix = qs ? `?${qs}` : '';
    const path = `/api/v1/teams/${teamId}/dms/${dmId}/messages${dmSuffix}`;
    const data = await this.request(conn.baseUrl, path, { method: 'GET' }, conn.token);
    return this.unwrapArray(data, 'messages');
  }

  async editDMMessage(teamId: string, dmId: string, msgId: string, content: string): Promise<unknown> {
    const conn = this.getConnection(teamId);
    return this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/dms/${dmId}/messages/${msgId}`,
      { method: 'PUT', body: JSON.stringify({ content }) },
      conn.token,
    );
  }

  async deleteDMMessage(teamId: string, dmId: string, msgId: string): Promise<void> {
    const conn = this.getConnection(teamId);
    await this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/dms/${dmId}/messages/${msgId}`,
      { method: 'DELETE' },
      conn.token,
    );
  }

  async addDMMembers(teamId: string, dmId: string, userIds: string[]): Promise<void> {
    const conn = this.getConnection(teamId);
    await this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/dms/${dmId}/members`,
      { method: 'POST', body: JSON.stringify({ user_ids: userIds }) },
      conn.token,
    );
  }

  async removeDMMember(teamId: string, dmId: string, userId: string): Promise<void> {
    const conn = this.getConnection(teamId);
    await this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/dms/${dmId}/members/${userId}`,
      { method: 'DELETE' },
      conn.token,
    );
  }

  // Threads
  async createThread(
    teamId: string,
    channelId: string,
    parentMessageId: string,
    title?: string,
  ): Promise<unknown> {
    const conn = this.getConnection(teamId);
    return this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/channels/${channelId}/threads`,
      { method: 'POST', body: JSON.stringify({ parent_message_id: parentMessageId, title: title ?? '' }) },
      conn.token,
    );
  }

  async getChannelThreads(teamId: string, channelId: string): Promise<unknown[]> {
    const conn = this.getConnection(teamId);
    const data = await this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/channels/${channelId}/threads`,
      { method: 'GET' },
      conn.token,
    );
    return this.unwrapArray(data, 'threads');
  }

  async getThread(teamId: string, threadId: string): Promise<unknown> {
    const conn = this.getConnection(teamId);
    const data = await this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/threads/${threadId}`,
      { method: 'GET' },
      conn.token,
    );
    return this.unwrapObject(data, 'thread');
  }

  async updateThread(teamId: string, threadId: string, title: string): Promise<unknown> {
    const conn = this.getConnection(teamId);
    return this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/threads/${threadId}`,
      { method: 'PUT', body: JSON.stringify({ title }) },
      conn.token,
    );
  }

  async deleteThread(teamId: string, threadId: string): Promise<void> {
    const conn = this.getConnection(teamId);
    await this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/threads/${threadId}`,
      { method: 'DELETE' },
      conn.token,
    );
  }

  async getThreadMessages(
    teamId: string,
    threadId: string,
    before?: string,
    limit?: number,
  ): Promise<unknown[]> {
    const conn = this.getConnection(teamId);
    const params = new URLSearchParams();
    if (before) params.set('before', before);
    if (limit != null) params.set('limit', String(limit));
    const qs = params.toString();
    const threadSuffix = qs ? `?${qs}` : '';
    const path = `/api/v1/teams/${teamId}/threads/${threadId}/messages${threadSuffix}`;
    const data = await this.request(conn.baseUrl, path, { method: 'GET' }, conn.token);
    return this.unwrapArray(data, 'messages');
  }

  // sendThreadMessage/editThreadMessage/deleteThreadMessage removed — thread messages are WS-only

  // Reactions
  async addReaction(teamId: string, channelId: string, messageId: string, emoji: string): Promise<void> {
    const conn = this.getConnection(teamId);
    await this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
      { method: 'PUT' },
      conn.token,
    );
  }

  async removeReaction(teamId: string, channelId: string, messageId: string, emoji: string): Promise<void> {
    const conn = this.getConnection(teamId);
    await this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
      { method: 'DELETE' },
      conn.token,
    );
  }

  async getReactions(teamId: string, channelId: string, messageId: string): Promise<ReactionGroup[]> {
    const conn = this.getConnection(teamId);
    return this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/channels/${channelId}/messages/${messageId}/reactions`,
      { method: 'GET' },
      conn.token,
    );
  }

  // File uploads
  async uploadFile(teamId: string, file: File): Promise<Attachment> {
    const conn = this.getConnection(teamId);
    const formData = new FormData();
    formData.append('file', file);

    const headers: Record<string, string> = {};
    // H-13d: drop bearer when same-origin (cookie carries auth).
    if (conn.token && !isSameOriginAsApi(conn.baseUrl)) {
      headers['Authorization'] = `Bearer ${conn.token}`;
    }

    const res = await fetch(`${conn.baseUrl}/api/v1/teams/${teamId}/upload`, {
      method: 'POST',
      headers,
      body: formData,
      // H-13b.1: cookie travels in lockstep with any bearer header.
      credentials: 'include',
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Upload error ${res.status}: ${body}`);
    }
    return res.json() as Promise<Attachment>;
  }

  getAttachmentUrl(teamId: string, attachmentId: string): string {
    const conn = this.getConnection(teamId);
    return `${conn.baseUrl}/api/v1/teams/${teamId}/attachments/${attachmentId}`;
  }

  async deleteAttachment(teamId: string, attachmentId: string): Promise<void> {
    const conn = this.getConnection(teamId);
    await this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/attachments/${attachmentId}`,
      { method: 'DELETE' },
      conn.token,
    );
  }

  // Presence
  async getPresences(teamId: string): Promise<Record<string, UserPresence>> {
    const conn = this.getConnection(teamId);
    const data = await this.request<unknown>(conn.baseUrl, `/api/v1/teams/${teamId}/presence`, { method: 'GET' }, conn.token);

    // Server wraps response as {presences: [...]} — unwrap to array first
    let arr: unknown[];
    if (Array.isArray(data)) {
      arr = data;
    } else {
      arr = this.unwrapArray(data, 'presences');
      // Also try 'presence' key
      if (arr.length === 0) arr = this.unwrapArray(data, 'presence');
    }

    // Transform array of {user_id, status_type, ...} to Record<userId, UserPresence>
    const result: Record<string, UserPresence> = {};
    for (const item of arr) {
      const p = item as { user_id?: string; status_type?: string; status?: string; custom_status?: string; last_active?: string };
      if (p.user_id) {
        result[p.user_id] = {
          user_id: p.user_id,
          status: (p.status_type || p.status || 'offline') as UserPresence['status'],
          custom_status: p.custom_status || '',
          last_active: p.last_active || '',
        };
      }
    }
    return result;
  }

  async getUserPresence(teamId: string, userId: string): Promise<UserPresence> {
    const conn = this.getConnection(teamId);
    return this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/presence/${userId}`,
      { method: 'GET' },
      conn.token,
    );
  }

  async updatePresence(teamId: string, status: string, customStatus?: string): Promise<void> {
    const conn = this.getConnection(teamId);
    await this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/presence`,
      {
        method: 'PUT',
        // Server's UpdatePresenceRequest expects { status, custom_status }.
        // Sending status_type made it 422 every time.
        body: JSON.stringify({ status: status, custom_status: customStatus ?? '' }),
      },
      conn.token,
    );
  }

  // Voice
  async getVoiceState(teamId: string, channelId: string): Promise<VoiceState> {
    const conn = this.getConnection(teamId);
    return this.request(
      conn.baseUrl,
      `/api/v1/teams/${teamId}/voice/${channelId}`,
      { method: 'GET' },
      conn.token,
    );
  }

  // joinVoice/leaveVoice removed — voice join/leave is WS-only

  async getTURNCredentials(teamId: string): Promise<{ iceServers: RTCIceServer[] }> {
    const conn = this.getConnection(teamId);
    return this.request(
      conn.baseUrl,
      `/api/v1/voice/credentials`,
      { method: 'GET' },
      conn.token,
    );
  }

  // Health
  async checkHealth(baseUrl: string): Promise<boolean> {
    try {
      await this.request(baseUrl, '/health', { method: 'GET' });
      return true;
    } catch {
      return false;
    }
  }

  async checkHealthWithLatency(baseUrl: string): Promise<{ ok: boolean; latency: number; uptime: string | null }> {
    const start = performance.now();
    try {
      const data = await this.request(baseUrl, '/health', { method: 'GET' });
      const latency = Math.round(performance.now() - start);
      return { ok: true, latency, uptime: (data as Record<string, unknown>)?.uptime as string || null };
    } catch {
      return { ok: false, latency: 0, uptime: null };
    }
  }

  // Prekey bundles (E2E encryption). `request` takes (baseUrl, path,
  // …) — passing teamId for baseUrl makes fetch resolve the URL as a
  // relative path against the Vite dev origin, which returns the dev
  // server's HTML index. That HTML then fails res.json() with
  // `SyntaxError: JSON.parse: unexpected character at line 1 column 1`
  // — the same error that blocked voice E2E key distribution to every
  // peer. Use conn.baseUrl + conn.token like every other endpoint.
  async uploadPrekeyBundle(
    teamId: string,
    bundle: {
      identity_key: string;
      // X25519 public DH key. Required by X3DH's DH2 step; without
      // this the peer's session-init fails with
      // `Data provided to an operation does not meet requirements`
      // when WebCrypto rejects an empty/wrong-shape buffer.
      identity_dh_key: string;
      signed_prekey: string;
      signed_prekey_signature: string;
      one_time_prekeys: string[];
    },
  ): Promise<void> {
    const conn = this.getConnection(teamId);
    await this.request(
      conn.baseUrl,
      '/api/v1/prekeys',
      {
        method: 'POST',
        body: JSON.stringify(bundle),
      },
      conn.token,
    );
  }

  /**
   * Fetch a user's prekey bundle.
   *
   * Pass `initiate: true` only when you're about to actually start an
   * X3DH session — that's the call site that needs an OTPK. Drive-by
   * fetches (identity-key lookup, safety-number recomputation) MUST
   * leave it false so the server doesn't drain the keyspace. VULN-006
   * server-side gate refuses cross-team lookups regardless.
   */
  async getPrekeyBundle(
    teamId: string,
    userId: string,
    options: { initiate?: boolean } = {},
  ): Promise<{
    identity_key: string;
    identity_dh_key: string;
    signed_prekey: string;
    signed_prekey_signature: string;
    one_time_prekeys: string[];
  }> {
    const conn = this.getConnection(teamId);
    const query = options.initiate ? '?initiate=true' : '';
    return this.request(
      conn.baseUrl,
      `/api/v1/prekeys/${userId}${query}`,
      { method: 'GET' },
      conn.token,
    );
  }

  // ─── Passkey-recoverable identity escrow ──────────────────────────
  // Design: .security-hardening/15-passkey-recoverable-identity-escrow.md
  //
  // The blob is encrypted client-side with the WebAuthn-PRF-derived
  // wrap key. Server never decrypts. PRF salt is opaque to the server
  // but mandatory for the client to re-derive the wrap key during
  // recovery.

  /** Upsert an escrowed recovery slot. Requires an authenticated
   *  connection (the same JWT used for any other PUT/POST). */
  async uploadRecoverySlot(
    teamId: string,
    slot: {
      credential_id: string;
      /** base64-encoded 32 bytes */
      prf_salt: string;
      /** base64-encoded AES-GCM ciphertext */
      encrypted_blob: string;
    },
  ): Promise<void> {
    const conn = this.getConnection(teamId);
    await this.request(
      conn.baseUrl,
      '/api/v1/identity/recovery/passkey',
      { method: 'PUT', body: JSON.stringify(slot) },
      conn.token,
    );
  }

  /** Delete an escrowed recovery slot — call when the user revokes the
   *  corresponding passkey. */
  async deleteRecoverySlot(teamId: string, credentialId: string): Promise<void> {
    const conn = this.getConnection(teamId);
    await this.request(
      conn.baseUrl,
      `/api/v1/identity/recovery/passkey/${encodeURIComponent(credentialId)}`,
      { method: 'DELETE' },
      conn.token,
    );
  }

  /** Look up credential descriptors for a username. Unauthenticated.
   *  Returns synthetic descriptors for unknown usernames so the caller
   *  cannot distinguish known from unknown. */
  async lookupRecoveryDescriptors(
    baseUrl: string,
    username: string,
  ): Promise<{
    rp_id: string;
    credentials: { credential_id: string; prf_salt: string }[];
  }> {
    return this.request(
      baseUrl,
      '/api/v1/identity/recovery/lookup',
      { method: 'POST', body: JSON.stringify({ username }) },
    );
  }

  /** Fetch the encrypted blob for a `(username, credential_id)` pair.
   *  Unauthenticated by design — the blob is cryptographically gated
   *  (PRF-encrypted), so server-side auth would only add complexity
   *  without changing the security boundary. Returns 404 for unknown
   *  pairs (identical for unknown-user and unknown-credential — no
   *  enumeration). */
  async fetchRecoveryBlob(
    baseUrl: string,
    username: string,
    credentialId: string,
  ): Promise<{
    credential_id: string;
    rp_id: string;
    prf_salt: string;
    encrypted_blob: string;
    user_id: string;
  }> {
    return this.request(
      baseUrl,
      '/api/v1/identity/recovery/fetch',
      { method: 'POST', body: JSON.stringify({ username, credential_id: credentialId }) },
    );
  }
}

export const api = new ApiService();

export function enableMockApi(mockService: Record<string, unknown>): void {
  const target = api as unknown as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(mockService))) {
    if (key !== 'constructor') {
      const val = mockService[key];
      target[key] = typeof val === 'function' ? val.bind(mockService) : val;
    }
  }
  for (const key of Object.keys(mockService)) {
    target[key] = mockService[key];
  }
}
