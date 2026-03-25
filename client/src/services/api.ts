import type { User } from '../stores/authStore';

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
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const res = await fetch(`${baseUrl}${path}`, { ...options, headers });
    if (!res.ok) {
      if (res.status === 401 && this.onAuthError) {
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

  // User profile
  async getMe(baseUrl: string, token: string): Promise<unknown> {
    const data = await this.request(baseUrl, '/api/v1/users/me', { method: 'GET' }, token);
    return this.unwrapObject(data, 'user');
  }

  async updateMe(
    baseUrl: string,
    token: string,
    updates: { display_name?: string; avatar_url?: string; status_text?: string; status_type?: string },
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
      { method: 'POST', body: JSON.stringify({ member_ids: memberIds }) },
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
    if (conn.token) {
      headers['Authorization'] = `Bearer ${conn.token}`;
    }

    const res = await fetch(`${conn.baseUrl}/api/v1/teams/${teamId}/upload`, {
      method: 'POST',
      headers,
      body: formData,
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
        body: JSON.stringify({ status_type: status, custom_status: customStatus ?? '' }),
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

  // Prekey bundles (E2E encryption)
  async uploadPrekeyBundle(
    teamId: string,
    bundle: {
      identity_key: string;
      signed_prekey: string;
      signed_prekey_signature: string;
      one_time_prekeys: string[];
    },
  ): Promise<void> {
    await this.request(teamId, '/api/v1/prekeys', {
      method: 'POST',
      body: JSON.stringify(bundle),
    });
  }

  async getPrekeyBundle(
    teamId: string,
    userId: string,
  ): Promise<{
    identity_key: string;
    signed_prekey: string;
    signed_prekey_signature: string;
    one_time_prekeys: string[];
  }> {
    return this.request(teamId, `/api/v1/prekeys/${userId}`, { method: 'GET' });
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
