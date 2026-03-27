import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from './api';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockFetchResponse(body: unknown, status = 200, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

function lastFetchCall(): { url: string; init: RequestInit } {
  const calls = vi.mocked(globalThis.fetch).mock.calls;
  const last = calls[calls.length - 1];
  return { url: last[0], init: last[1] };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ApiService', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // Reset internal state by removing all teams
    // We re-add as needed per test
    globalThis.fetch = mockFetchResponse({});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ── Connection management ─────────────────────────────────────────────────

  describe('addTeam / removeTeam', () => {
    it('adds a team connection and allows requests', async () => {
      api.addTeam('t1', 'https://example.com');
      api.setToken('t1', 'tok-abc');

      globalThis.fetch = mockFetchResponse({ channels: [] });
      const result = await api.getChannels('t1');

      expect(result).toEqual([]);
      expect(lastFetchCall().url).toBe('https://example.com/api/v1/teams/t1/channels');
    });

    it('removeTeam makes subsequent requests throw', () => {
      api.addTeam('t-remove', 'https://example.com');
      api.removeTeam('t-remove');

      expect(() => api.getChannels('t-remove')).rejects.toThrow('Not connected to team t-remove');
    });
  });

  // ── setToken ──────────────────────────────────────────────────────────────

  describe('setToken', () => {
    it('sets Bearer token sent in subsequent requests', async () => {
      api.addTeam('t-tok', 'https://s.io');
      api.setToken('t-tok', 'my-jwt');

      globalThis.fetch = mockFetchResponse({ channels: [] });
      await api.getChannels('t-tok');

      const { init } = lastFetchCall();
      expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer my-jwt');
    });

    it('does nothing for unknown team', () => {
      expect(() => api.setToken('nonexistent', 'tok')).not.toThrow();
    });
  });

  // ── getConnectionInfo ─────────────────────────────────────────────────────

  describe('getConnectionInfo', () => {
    it('returns baseUrl and token for known team', () => {
      api.addTeam('t-info', 'https://info.io');
      api.setToken('t-info', 'jwt-123');

      const info = api.getConnectionInfo('t-info');
      expect(info).toEqual({ baseUrl: 'https://info.io', token: 'jwt-123' });
    });

    it('returns null for unknown team', () => {
      expect(api.getConnectionInfo('unknown')).toBeNull();
    });
  });

  // ── Auth error handler ────────────────────────────────────────────────────

  describe('setAuthErrorHandler', () => {
    it('calls handler on 401 response for authenticated request', async () => {
      const handler = vi.fn();
      api.setAuthErrorHandler(handler);
      api.addTeam('t-auth', 'https://auth.io');
      api.setToken('t-auth', 'some-jwt-token');

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
      });

      await expect(api.getChannels('t-auth')).rejects.toThrow('Unauthorized');
      expect(handler).toHaveBeenCalledOnce();
    });

    it('does not call handler on 401 from public auth endpoint (no token)', async () => {
      const handler = vi.fn();
      api.setAuthErrorHandler(handler);
      api.addTeam('t-auth2', 'https://auth.io');
      // No setToken — simulates public auth/verify call

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('invalid signature'),
      });

      await expect(api.getChannels('t-auth2')).rejects.toThrow('invalid signature');
      expect(handler).not.toHaveBeenCalled();
    });

    it('does not call handler on non-401 errors', async () => {
      const handler = vi.fn();
      api.setAuthErrorHandler(handler);
      api.addTeam('t-500', 'https://err.io');

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });

      await expect(api.getChannels('t-500')).rejects.toThrow();
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ── Request construction ──────────────────────────────────────────────────

  describe('request construction', () => {
    it('sends Content-Type application/json', async () => {
      api.addTeam('t-ct', 'https://ct.io');
      globalThis.fetch = mockFetchResponse({});

      await api.getTeam('t-ct');

      const { init } = lastFetchCall();
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    });

    it('sends no Authorization header when token is null', async () => {
      api.addTeam('t-noauth', 'https://no.io');
      // Don't set token
      globalThis.fetch = mockFetchResponse({});

      // Use requestChallenge which doesn't use conn.token
      await api.requestChallenge('t-noauth', 'pub-key');

      const { init } = lastFetchCall();
      expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined();
    });
  });

  // ── Error response handling ───────────────────────────────────────────────

  describe('error response handling', () => {
    it('extracts error field from JSON error body', async () => {
      api.addTeam('t-err', 'https://err.io');
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve(JSON.stringify({ error: 'Bad request: missing field' })),
      });

      await expect(api.getTeam('t-err')).rejects.toThrow('Bad request: missing field');
    });

    it('uses raw text when body is not JSON', async () => {
      api.addTeam('t-raw', 'https://raw.io');
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        text: () => Promise.resolve('Bad Gateway'),
      });

      await expect(api.getTeam('t-raw')).rejects.toThrow('Bad Gateway');
    });

    it('falls back to status code when body is empty', async () => {
      api.addTeam('t-empty', 'https://empty.io');
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: () => Promise.resolve(''),
      });

      await expect(api.getTeam('t-empty')).rejects.toThrow('Server returned 503');
    });
  });

  // ── Unwrap helpers ────────────────────────────────────────────────────────

  describe('unwrapArray (via getChannels)', () => {
    it('unwraps {channels: [...]} to array', async () => {
      api.addTeam('t-ua', 'https://ua.io');
      globalThis.fetch = mockFetchResponse({ channels: [{ id: 'c1' }, { id: 'c2' }] });

      const result = await api.getChannels('t-ua');
      expect(result).toEqual([{ id: 'c1' }, { id: 'c2' }]);
    });

    it('returns array directly if response is already an array', async () => {
      api.addTeam('t-arr', 'https://arr.io');
      globalThis.fetch = mockFetchResponse([{ id: 'c1' }]);

      const result = await api.getChannels('t-arr');
      expect(result).toEqual([{ id: 'c1' }]);
    });

    it('returns empty array for mismatched key', async () => {
      api.addTeam('t-mm', 'https://mm.io');
      globalThis.fetch = mockFetchResponse({ wrong_key: [1, 2, 3] });

      const result = await api.getChannels('t-mm');
      expect(result).toEqual([]);
    });
  });

  describe('unwrapObject (via getMe)', () => {
    it('unwraps {user: {...}} to object', async () => {
      globalThis.fetch = mockFetchResponse({ user: { id: 'u1', name: 'Alice' } });

      const result = await api.getMe('https://me.io', 'tok');
      expect(result).toEqual({ id: 'u1', name: 'Alice' });
    });

    it('returns data as-is when key not present', async () => {
      globalThis.fetch = mockFetchResponse({ id: 'u1', name: 'Alice' });

      const result = await api.getMe('https://me.io', 'tok');
      expect(result).toEqual({ id: 'u1', name: 'Alice' });
    });
  });

  // ── Auth endpoints ────────────────────────────────────────────────────────

  describe('requestChallenge', () => {
    it('posts public_key to /api/v1/auth/challenge', async () => {
      api.addTeam('t-ch', 'https://ch.io');
      globalThis.fetch = mockFetchResponse({ challenge_id: 'abc', nonce: '123' });

      const result = await api.requestChallenge('t-ch', 'pub-key-hex');

      expect(result).toEqual({ challenge_id: 'abc', nonce: '123' });
      const { url, init } = lastFetchCall();
      expect(url).toBe('https://ch.io/api/v1/auth/challenge');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({ public_key: 'pub-key-hex' });
    });
  });

  describe('verifyChallenge', () => {
    it('posts challenge verification data', async () => {
      api.addTeam('t-vc', 'https://vc.io');
      globalThis.fetch = mockFetchResponse({ token: 'jwt', user: { id: 'u1' } });

      const result = await api.verifyChallenge('t-vc', 'cid', 'pk', 'sig');

      expect(result.token).toBe('jwt');
      const body = JSON.parse(lastFetchCall().init.body as string);
      expect(body).toEqual({ challenge_id: 'cid', public_key: 'pk', signature: 'sig' });
    });
  });

  describe('register', () => {
    it('posts registration data', async () => {
      api.addTeam('t-reg', 'https://reg.io');
      globalThis.fetch = mockFetchResponse({ user: {}, token: 'tok' });

      await api.register('t-reg', 'ch-1', 'pk', 'sig123', 'alice', 'inv-token');

      const body = JSON.parse(lastFetchCall().init.body as string);
      expect(body).toEqual({
        challenge_id: 'ch-1',
        public_key: 'pk',
        signature: 'sig123',
        username: 'alice',
        invite_token: 'inv-token',
      });
    });
  });

  // ── Channel endpoints ─────────────────────────────────────────────────────

  describe('createChannel', () => {
    it('sends POST with channel data', async () => {
      api.addTeam('t-cc', 'https://cc.io');
      api.setToken('t-cc', 'tok');
      globalThis.fetch = mockFetchResponse({ id: 'ch1', name: 'general' });

      await api.createChannel('t-cc', { name: 'general', type: 'text', topic: 'hi' });

      const { url, init } = lastFetchCall();
      expect(url).toBe('https://cc.io/api/v1/teams/t-cc/channels');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({ name: 'general', type: 'text', topic: 'hi' });
    });
  });

  describe('deleteChannel', () => {
    it('sends DELETE request', async () => {
      api.addTeam('t-dc', 'https://dc.io');
      api.setToken('t-dc', 'tok');
      globalThis.fetch = mockFetchResponse({});

      await api.deleteChannel('t-dc', 'ch1');

      const { url, init } = lastFetchCall();
      expect(url).toBe('https://dc.io/api/v1/teams/t-dc/channels/ch1');
      expect(init.method).toBe('DELETE');
    });
  });

  // ── Messages ──────────────────────────────────────────────────────────────

  describe('getMessages', () => {
    it('constructs correct URL with query params', async () => {
      api.addTeam('t-msg', 'https://msg.io');
      api.setToken('t-msg', 'tok');
      globalThis.fetch = mockFetchResponse({ messages: [{ id: 'm1' }] });

      const result = await api.getMessages('t-msg', 'ch1', 50, 'before-id');

      expect(result).toEqual([{ id: 'm1' }]);
      const { url } = lastFetchCall();
      expect(url).toContain('/api/v1/teams/t-msg/channels/ch1/messages?');
      expect(url).toContain('limit=50');
      expect(url).toContain('before=before-id');
    });

    it('omits query params when not provided', async () => {
      api.addTeam('t-msg2', 'https://msg2.io');
      api.setToken('t-msg2', 'tok');
      globalThis.fetch = mockFetchResponse({ messages: [] });

      await api.getMessages('t-msg2', 'ch1');

      const { url } = lastFetchCall();
      expect(url).toBe('https://msg2.io/api/v1/teams/t-msg2/channels/ch1/messages');
    });
  });

  // ── Members ───────────────────────────────────────────────────────────────

  describe('getMembers', () => {
    it('unwraps members array', async () => {
      api.addTeam('t-mem', 'https://mem.io');
      api.setToken('t-mem', 'tok');
      globalThis.fetch = mockFetchResponse({ members: [{ id: 'u1' }] });

      const result = await api.getMembers('t-mem');
      expect(result).toEqual([{ id: 'u1' }]);
    });
  });

  describe('kickMember', () => {
    it('sends DELETE to member endpoint', async () => {
      api.addTeam('t-kick', 'https://kick.io');
      api.setToken('t-kick', 'tok');
      globalThis.fetch = mockFetchResponse({});

      await api.kickMember('t-kick', 'u1');

      const { url, init } = lastFetchCall();
      expect(url).toBe('https://kick.io/api/v1/teams/t-kick/members/u1');
      expect(init.method).toBe('DELETE');
    });
  });

  describe('banMember / unbanMember', () => {
    it('banMember sends POST to ban endpoint', async () => {
      api.addTeam('t-ban', 'https://ban.io');
      api.setToken('t-ban', 'tok');
      globalThis.fetch = mockFetchResponse({});

      await api.banMember('t-ban', 'u1');

      const { url, init } = lastFetchCall();
      expect(url).toBe('https://ban.io/api/v1/teams/t-ban/members/u1/ban');
      expect(init.method).toBe('POST');
    });

    it('unbanMember sends DELETE to ban endpoint', async () => {
      api.addTeam('t-unban', 'https://unban.io');
      api.setToken('t-unban', 'tok');
      globalThis.fetch = mockFetchResponse({});

      await api.unbanMember('t-unban', 'u1');

      expect(lastFetchCall().init.method).toBe('DELETE');
    });
  });

  // ── Roles ─────────────────────────────────────────────────────────────────

  describe('getRoles / createRole', () => {
    it('getRoles unwraps roles array', async () => {
      api.addTeam('t-role', 'https://role.io');
      api.setToken('t-role', 'tok');
      globalThis.fetch = mockFetchResponse({ roles: [{ id: 'r1', name: 'Admin' }] });

      const roles = await api.getRoles('t-role');
      expect(roles).toEqual([{ id: 'r1', name: 'Admin' }]);
    });

    it('createRole sends POST with role data', async () => {
      api.addTeam('t-cr', 'https://cr.io');
      api.setToken('t-cr', 'tok');
      globalThis.fetch = mockFetchResponse({ id: 'r1' });

      await api.createRole('t-cr', { name: 'Mod', color: '#ff0', permissions: 7 });

      const body = JSON.parse(lastFetchCall().init.body as string);
      expect(body).toEqual({ name: 'Mod', color: '#ff0', permissions: 7 });
    });
  });

  // ── DMs ───────────────────────────────────────────────────────────────────

  describe('createDM', () => {
    it('posts member_ids to DM endpoint', async () => {
      api.addTeam('t-dm', 'https://dm.io');
      api.setToken('t-dm', 'tok');
      globalThis.fetch = mockFetchResponse({ id: 'dm1' });

      await api.createDM('t-dm', ['u1', 'u2']);

      const body = JSON.parse(lastFetchCall().init.body as string);
      expect(body).toEqual({ member_ids: ['u1', 'u2'] });
    });
  });

  describe('getDMMessages', () => {
    it('constructs URL with pagination params', async () => {
      api.addTeam('t-dmm', 'https://dmm.io');
      api.setToken('t-dmm', 'tok');
      globalThis.fetch = mockFetchResponse({ messages: [] });

      await api.getDMMessages('t-dmm', 'dm1', 'before-id', 25);

      const { url } = lastFetchCall();
      expect(url).toContain('before=before-id');
      expect(url).toContain('limit=25');
    });
  });

  // ── Threads ───────────────────────────────────────────────────────────────

  describe('createThread', () => {
    it('posts thread creation data', async () => {
      api.addTeam('t-th', 'https://th.io');
      api.setToken('t-th', 'tok');
      globalThis.fetch = mockFetchResponse({ id: 'th1' });

      await api.createThread('t-th', 'ch1', 'msg1', 'Discussion');

      const body = JSON.parse(lastFetchCall().init.body as string);
      expect(body).toEqual({ parent_message_id: 'msg1', title: 'Discussion' });
    });
  });

  // ── Reactions ─────────────────────────────────────────────────────────────

  describe('addReaction / removeReaction', () => {
    it('addReaction sends PUT with encoded emoji', async () => {
      api.addTeam('t-react', 'https://react.io');
      api.setToken('t-react', 'tok');
      globalThis.fetch = mockFetchResponse({});

      await api.addReaction('t-react', 'ch1', 'msg1', '👍');

      const { url, init } = lastFetchCall();
      expect(url).toContain(encodeURIComponent('👍'));
      expect(init.method).toBe('PUT');
    });

    it('removeReaction sends DELETE', async () => {
      api.addTeam('t-rr', 'https://rr.io');
      api.setToken('t-rr', 'tok');
      globalThis.fetch = mockFetchResponse({});

      await api.removeReaction('t-rr', 'ch1', 'msg1', '🎉');
      expect(lastFetchCall().init.method).toBe('DELETE');
    });
  });

  // ── File uploads ──────────────────────────────────────────────────────────

  describe('uploadFile', () => {
    it('sends FormData with auth header', async () => {
      api.addTeam('t-up', 'https://up.io');
      api.setToken('t-up', 'my-token');

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: 'att1', filename: 'test.png' }),
      });

      const file = new File(['data'], 'test.png', { type: 'image/png' });
      const result = await api.uploadFile('t-up', file);

      expect(result.id).toBe('att1');
      const { url, init } = lastFetchCall();
      expect(url).toBe('https://up.io/api/v1/teams/t-up/upload');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer my-token');
      expect(init.body).toBeInstanceOf(FormData);
    });
  });

  describe('getAttachmentUrl', () => {
    it('returns correct URL', () => {
      api.addTeam('t-att', 'https://att.io');
      const url = api.getAttachmentUrl('t-att', 'att123');
      expect(url).toBe('https://att.io/api/v1/teams/t-att/attachments/att123');
    });
  });

  // ── Presence ──────────────────────────────────────────────────────────────

  describe('getPresences', () => {
    it('transforms presences array to record', async () => {
      api.addTeam('t-pres', 'https://pres.io');
      api.setToken('t-pres', 'tok');
      globalThis.fetch = mockFetchResponse({
        presences: [
          { user_id: 'u1', status_type: 'online', custom_status: 'Working', last_active: '2024-01-01' },
          { user_id: 'u2', status_type: 'idle' },
        ],
      });

      const result = await api.getPresences('t-pres');
      expect(result['u1']).toEqual({
        user_id: 'u1',
        status: 'online',
        custom_status: 'Working',
        last_active: '2024-01-01',
      });
      expect(result['u2'].status).toBe('idle');
    });
  });

  // ── Health ────────────────────────────────────────────────────────────────

  describe('checkHealth', () => {
    it('returns true on success', async () => {
      globalThis.fetch = mockFetchResponse({ status: 'ok' });
      const ok = await api.checkHealth('https://h.io');
      expect(ok).toBe(true);
    });

    it('returns false on error', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
      const ok = await api.checkHealth('https://h.io');
      expect(ok).toBe(false);
    });
  });

  describe('checkHealthWithLatency', () => {
    it('returns ok, latency, and uptime', async () => {
      globalThis.fetch = mockFetchResponse({ uptime: '2h30m' });
      const result = await api.checkHealthWithLatency('https://h.io');
      expect(result.ok).toBe(true);
      expect(result.latency).toBeGreaterThanOrEqual(0);
      expect(result.uptime).toBe('2h30m');
    });

    it('returns ok=false on failure', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('down'));
      const result = await api.checkHealthWithLatency('https://h.io');
      expect(result.ok).toBe(false);
      expect(result.latency).toBe(0);
    });
  });

  // ── Invites ───────────────────────────────────────────────────────────────

  describe('invites', () => {
    it('createInvite posts to team invites endpoint', async () => {
      api.addTeam('t-inv', 'https://inv.io');
      api.setToken('t-inv', 'tok');
      globalThis.fetch = mockFetchResponse({ code: 'abc123' });

      await api.createInvite('t-inv', 5, 24);

      const { url, init } = lastFetchCall();
      expect(url).toBe('https://inv.io/api/v1/teams/t-inv/invites');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ max_uses: 5, expires_in_hours: 24 });
    });

    it('listInvites unwraps invites array', async () => {
      api.addTeam('t-li', 'https://li.io');
      api.setToken('t-li', 'tok');
      globalThis.fetch = mockFetchResponse({ invites: [{ id: 'i1' }] });

      const result = await api.listInvites('t-li');
      expect(result).toEqual([{ id: 'i1' }]);
    });

    it('revokeInvite sends DELETE', async () => {
      api.addTeam('t-ri', 'https://ri.io');
      api.setToken('t-ri', 'tok');
      globalThis.fetch = mockFetchResponse({});

      await api.revokeInvite('t-ri', 'inv1');

      const { url, init } = lastFetchCall();
      expect(url).toBe('https://ri.io/api/v1/teams/t-ri/invites/inv1');
      expect(init.method).toBe('DELETE');
    });
  });

  // ── Federation ────────────────────────────────────────────────────────────

  describe('federation', () => {
    it('getFederationStatus returns status object', async () => {
      api.addTeam('t-fed', 'https://fed.io');
      api.setToken('t-fed', 'tok');
      globalThis.fetch = mockFetchResponse({ node_name: 'node1', peers: [], lamport_ts: 42 });

      const result = await api.getFederationStatus('t-fed');
      expect(result.node_name).toBe('node1');
      expect(result.lamport_ts).toBe(42);
    });
  });

  // ── Unknown team throws ───────────────────────────────────────────────────

  describe('unknown team', () => {
    it('throws when accessing unregistered team', () => {
      expect(() => api.getChannels('no-such-team')).rejects.toThrow('Not connected to team no-such-team');
    });
  });

  // ── Bootstrap ────────────────────────────────────────────────────────────

  describe('bootstrap', () => {
    it('posts bootstrap data with team_name', async () => {
      api.addTeam('t-boot', 'https://boot.io');
      globalThis.fetch = mockFetchResponse({ user: {}, token: 'tok', team: {} });

      await api.bootstrap('t-boot', 'ch-1', 'pk', 'sig123', 'alice', 'btoken', 'My Team');

      const body = JSON.parse(lastFetchCall().init.body as string);
      expect(body).toEqual({
        challenge_id: 'ch-1',
        public_key: 'pk',
        signature: 'sig123',
        username: 'alice',
        bootstrap_token: 'btoken',
        team_name: 'My Team',
      });
    });

    it('omits team_name when not provided', async () => {
      api.addTeam('t-boot2', 'https://boot2.io');
      globalThis.fetch = mockFetchResponse({ user: {}, token: 'tok', team: {} });

      await api.bootstrap('t-boot2', 'ch-2', 'pk', 'sig456', 'alice', 'btoken');

      const body = JSON.parse(lastFetchCall().init.body as string);
      expect(body.team_name).toBeUndefined();
    });
  });

  // ── updateMe ────────────────────────────────────────────────────────────

  describe('updateMe', () => {
    it('sends PATCH with user updates', async () => {
      globalThis.fetch = mockFetchResponse({ user: { id: 'u1', display_name: 'Updated' } });
      const result = await api.updateMe('https://me.io', 'tok', { display_name: 'Updated' });

      expect(result).toEqual({ id: 'u1', display_name: 'Updated' });
      const { init } = lastFetchCall();
      expect(init.method).toBe('PATCH');
    });
  });

  // ── updateChannel ────────────────────────────────────────────────────────

  describe('updateChannel', () => {
    it('sends PATCH with channel updates', async () => {
      api.addTeam('t-uc', 'https://uc.io');
      api.setToken('t-uc', 'tok');
      globalThis.fetch = mockFetchResponse({ id: 'ch1', name: 'renamed' });

      await api.updateChannel('t-uc', 'ch1', { name: 'renamed' });

      const { url, init } = lastFetchCall();
      expect(url).toBe('https://uc.io/api/v1/teams/t-uc/channels/ch1');
      expect(init.method).toBe('PATCH');
    });
  });

  // ── updateTeam ────────────────────────────────────────────────────────────

  describe('updateTeam', () => {
    it('sends PATCH to team endpoint', async () => {
      api.addTeam('t-ut', 'https://ut.io');
      api.setToken('t-ut', 'tok');
      globalThis.fetch = mockFetchResponse({});

      await api.updateTeam('t-ut', { name: 'New Name' });

      const { init } = lastFetchCall();
      expect(init.method).toBe('PATCH');
    });
  });

  // ── updateMember ────────────────────────────────────────────────────────

  describe('updateMember', () => {
    it('sends PATCH to member endpoint', async () => {
      api.addTeam('t-um', 'https://um.io');
      api.setToken('t-um', 'tok');
      globalThis.fetch = mockFetchResponse({});

      await api.updateMember('t-um', 'u1', { nickname: 'nick' });

      const { url, init } = lastFetchCall();
      expect(url).toBe('https://um.io/api/v1/teams/t-um/members/u1');
      expect(init.method).toBe('PATCH');
    });
  });

  // ── Threads (extended) ─────────────────────────────────────────────────

  describe('getChannelThreads', () => {
    it('unwraps threads array', async () => {
      api.addTeam('t-gct', 'https://gct.io');
      api.setToken('t-gct', 'tok');
      globalThis.fetch = mockFetchResponse({ threads: [{ id: 'th1' }] });

      const result = await api.getChannelThreads('t-gct', 'ch1');
      expect(result).toEqual([{ id: 'th1' }]);
    });
  });

  describe('getThread', () => {
    it('unwraps thread object', async () => {
      api.addTeam('t-gt', 'https://gt.io');
      api.setToken('t-gt', 'tok');
      globalThis.fetch = mockFetchResponse({ thread: { id: 'th1', title: 'Test' } });

      const result = await api.getThread('t-gt', 'th1');
      expect(result).toEqual({ id: 'th1', title: 'Test' });
    });
  });

  describe('getThreadMessages', () => {
    it('constructs URL with params', async () => {
      api.addTeam('t-gtm', 'https://gtm.io');
      api.setToken('t-gtm', 'tok');
      globalThis.fetch = mockFetchResponse({ messages: [{ id: 'm1' }] });

      const result = await api.getThreadMessages('t-gtm', 'th1', 'before-id', 25);
      expect(result).toEqual([{ id: 'm1' }]);
      const { url } = lastFetchCall();
      expect(url).toContain('before=before-id');
      expect(url).toContain('limit=25');
    });
  });

  // ── DM extended ─────────────────────────────────────────────────────────

  describe('getDMChannel', () => {
    it('unwraps channel object', async () => {
      api.addTeam('t-gdc', 'https://gdc.io');
      api.setToken('t-gdc', 'tok');
      globalThis.fetch = mockFetchResponse({ channel: { id: 'dm1' } });

      const result = await api.getDMChannel('t-gdc', 'dm1');
      expect(result).toEqual({ id: 'dm1' });
    });
  });

  describe('sendDMMessage', () => {
    it('posts content', async () => {
      api.addTeam('t-sdm', 'https://sdm.io');
      api.setToken('t-sdm', 'tok');
      globalThis.fetch = mockFetchResponse({ id: 'm1' });

      await api.sendDMMessage('t-sdm', 'dm1', 'Hello');

      const body = JSON.parse(lastFetchCall().init.body as string);
      expect(body).toEqual({ content: 'Hello' });
    });
  });

  describe('editDMMessage', () => {
    it('sends PUT', async () => {
      api.addTeam('t-edm', 'https://edm.io');
      api.setToken('t-edm', 'tok');
      globalThis.fetch = mockFetchResponse({});

      await api.editDMMessage('t-edm', 'dm1', 'm1', 'Updated');
      expect(lastFetchCall().init.method).toBe('PUT');
    });
  });

  describe('deleteDMMessage', () => {
    it('sends DELETE', async () => {
      api.addTeam('t-ddm', 'https://ddm.io');
      api.setToken('t-ddm', 'tok');
      globalThis.fetch = mockFetchResponse({});

      await api.deleteDMMessage('t-ddm', 'dm1', 'm1');
      expect(lastFetchCall().init.method).toBe('DELETE');
    });
  });

  describe('addDMMembers', () => {
    it('posts user_ids', async () => {
      api.addTeam('t-adm', 'https://adm.io');
      api.setToken('t-adm', 'tok');
      globalThis.fetch = mockFetchResponse({});

      await api.addDMMembers('t-adm', 'dm1', ['u1', 'u2']);
      const body = JSON.parse(lastFetchCall().init.body as string);
      expect(body).toEqual({ user_ids: ['u1', 'u2'] });
    });
  });

  describe('removeDMMember', () => {
    it('sends DELETE to member endpoint', async () => {
      api.addTeam('t-rdm', 'https://rdm.io');
      api.setToken('t-rdm', 'tok');
      globalThis.fetch = mockFetchResponse({});

      await api.removeDMMember('t-rdm', 'dm1', 'u1');
      expect(lastFetchCall().init.method).toBe('DELETE');
    });
  });

  // ── Roles extended ──────────────────────────────────────────────────────

  describe('updateRole', () => {
    it('sends PATCH', async () => {
      api.addTeam('t-ur', 'https://ur.io');
      api.setToken('t-ur', 'tok');
      globalThis.fetch = mockFetchResponse({});

      await api.updateRole('t-ur', 'r1', { name: 'Renamed' });
      expect(lastFetchCall().init.method).toBe('PATCH');
    });
  });

  describe('deleteRole', () => {
    it('sends DELETE', async () => {
      api.addTeam('t-dr', 'https://dr.io');
      api.setToken('t-dr', 'tok');
      globalThis.fetch = mockFetchResponse({});

      await api.deleteRole('t-dr', 'r1');
      expect(lastFetchCall().init.method).toBe('DELETE');
    });
  });

  // ── Presence extended ───────────────────────────────────────────────────

  describe('getUserPresence', () => {
    it('fetches user presence', async () => {
      api.addTeam('t-gup', 'https://gup.io');
      api.setToken('t-gup', 'tok');
      globalThis.fetch = mockFetchResponse({ user_id: 'u1', status: 'online' });

      const result = await api.getUserPresence('t-gup', 'u1');
      expect(result.user_id).toBe('u1');
    });
  });

  describe('updatePresence', () => {
    it('sends PUT with status', async () => {
      api.addTeam('t-upres', 'https://upres.io');
      api.setToken('t-upres', 'tok');
      globalThis.fetch = mockFetchResponse({});

      await api.updatePresence('t-upres', 'online', 'Working');

      const body = JSON.parse(lastFetchCall().init.body as string);
      expect(body).toEqual({ status_type: 'online', custom_status: 'Working' });
    });
  });

  // ── getPresences with alternate key ──────────────────────────────────────

  describe('getPresences with presence key', () => {
    it('handles presence key', async () => {
      api.addTeam('t-pres2', 'https://pres2.io');
      api.setToken('t-pres2', 'tok');
      globalThis.fetch = mockFetchResponse({
        presence: [{ user_id: 'u1', status: 'online' }],
      });

      const result = await api.getPresences('t-pres2');
      expect(result['u1'].status).toBe('online');
    });

    it('handles direct array response', async () => {
      api.addTeam('t-pres3', 'https://pres3.io');
      api.setToken('t-pres3', 'tok');
      globalThis.fetch = mockFetchResponse([{ user_id: 'u1', status_type: 'idle' }]);

      const result = await api.getPresences('t-pres3');
      expect(result['u1'].status).toBe('idle');
    });
  });

  // ── deleteAttachment ────────────────────────────────────────────────────

  describe('deleteAttachment', () => {
    it('sends DELETE', async () => {
      api.addTeam('t-da', 'https://da.io');
      api.setToken('t-da', 'tok');
      globalThis.fetch = mockFetchResponse({});

      await api.deleteAttachment('t-da', 'att1');
      expect(lastFetchCall().init.method).toBe('DELETE');
    });
  });

  // ── uploadFile error ────────────────────────────────────────────────────

  describe('uploadFile error', () => {
    it('throws on error response', async () => {
      api.addTeam('t-ufe', 'https://ufe.io');
      api.setToken('t-ufe', 'tok');

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 413,
        text: () => Promise.resolve('File too large'),
      });

      const file = new File(['data'], 'big.bin', { type: 'application/octet-stream' });
      await expect(api.uploadFile('t-ufe', file)).rejects.toThrow('Upload error 413: File too large');
    });
  });

  // ── getInviteInfo ────────────────────────────────────────────────────────

  describe('getInviteInfo', () => {
    it('fetches invite info by token', async () => {
      globalThis.fetch = mockFetchResponse({ team_name: 'Cool Team' });
      const result = await api.getInviteInfo('https://inv.io', 'abc123') as Record<string, unknown>;
      expect(result.team_name).toBe('Cool Team');
      const { url } = lastFetchCall();
      expect(url).toBe('https://inv.io/api/v1/invites/abc123/info');
    });
  });

  // ── listTeams / createTeam ──────────────────────────────────────────────

  describe('listTeams', () => {
    it('unwraps teams array', async () => {
      globalThis.fetch = mockFetchResponse({ teams: [{ id: 't1' }] });
      const result = await api.listTeams('https://lt.io', 'tok');
      expect(result).toEqual([{ id: 't1' }]);
    });
  });

  describe('createTeam', () => {
    it('unwraps team object', async () => {
      globalThis.fetch = mockFetchResponse({ team: { id: 't1', name: 'New' } });
      const result = await api.createTeam('https://ct.io', 'tok', 'New', 'desc');
      expect(result).toEqual({ id: 't1', name: 'New' });
    });
  });

  // ── generateJoinToken ─────────────────────────────────────────────────

  describe('generateJoinToken', () => {
    it('posts to join-token endpoint', async () => {
      api.addTeam('t-jt', 'https://jt.io');
      api.setToken('t-jt', 'tok');
      globalThis.fetch = mockFetchResponse({ token: 'abc', join_command: 'dilla join abc' });

      const result = await api.generateJoinToken('t-jt');
      expect(result.token).toBe('abc');
      expect(result.join_command).toBe('dilla join abc');
      const { url, init } = lastFetchCall();
      expect(url).toBe('https://jt.io/api/v1/federation/join-token');
      expect(init.method).toBe('POST');
    });
  });

  // ── getDMChannels ───────────────────────────────────────────────────

  describe('getDMChannels', () => {
    it('unwraps channels array', async () => {
      api.addTeam('t-gdmc', 'https://gdmc.io');
      api.setToken('t-gdmc', 'tok');
      globalThis.fetch = mockFetchResponse({ channels: [{ id: 'dm1' }, { id: 'dm2' }] });

      const result = await api.getDMChannels('t-gdmc');
      expect(result).toEqual([{ id: 'dm1' }, { id: 'dm2' }]);
    });
  });

  // ── Prekey bundles ──────────────────────────────────────────────────

  describe('uploadPrekeyBundle', () => {
    it('posts bundle to prekeys endpoint', async () => {
      api.addTeam('t-upk', 'https://upk.io');
      api.setToken('t-upk', 'tok');
      globalThis.fetch = mockFetchResponse({});

      await api.uploadPrekeyBundle('t-upk', {
        identity_key: 'ik',
        signed_prekey: 'spk',
        signed_prekey_signature: 'sig',
        one_time_prekeys: ['otk1', 'otk2'],
      });

      const { url, init } = lastFetchCall();
      // uploadPrekeyBundle passes teamId directly as baseUrl
      expect(url).toBe('t-upk/api/v1/prekeys');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body as string);
      expect(body.identity_key).toBe('ik');
      expect(body.one_time_prekeys).toEqual(['otk1', 'otk2']);
    });
  });

  describe('getPrekeyBundle', () => {
    it('fetches prekey bundle for user', async () => {
      api.addTeam('t-gpk', 'https://gpk.io');
      api.setToken('t-gpk', 'tok');
      globalThis.fetch = mockFetchResponse({
        identity_key: 'ik',
        signed_prekey: 'spk',
        signed_prekey_signature: 'sig',
        one_time_prekeys: ['otk1'],
      });

      const result = await api.getPrekeyBundle('t-gpk', 'user-1');
      expect(result.identity_key).toBe('ik');
      const { url } = lastFetchCall();
      // getPrekeyBundle passes teamId directly as baseUrl
      expect(url).toBe('t-gpk/api/v1/prekeys/user-1');
    });
  });

  // ── federation peers ────────────────────────────────────────────────────

  describe('getFederationPeers', () => {
    it('returns peers array', async () => {
      api.addTeam('t-fp', 'https://fp.io');
      api.setToken('t-fp', 'tok');
      globalThis.fetch = mockFetchResponse([{ name: 'node1' }]);

      const result = await api.getFederationPeers('t-fp');
      expect(result).toEqual([{ name: 'node1' }]);
    });
  });

  // ── Voice ────────────────────────────────────────────────────────────────

  describe('getVoiceState', () => {
    it('fetches voice state', async () => {
      api.addTeam('t-vs', 'https://vs.io');
      api.setToken('t-vs', 'tok');
      globalThis.fetch = mockFetchResponse({ channel_id: 'ch1', peers: [] });

      const result = await api.getVoiceState('t-vs', 'ch1');
      expect(result.channel_id).toBe('ch1');
    });
  });

  describe('getTURNCredentials', () => {
    it('fetches TURN credentials', async () => {
      api.addTeam('t-turn', 'https://turn.io');
      api.setToken('t-turn', 'tok');
      globalThis.fetch = mockFetchResponse({ iceServers: [{ urls: 'turn:turn.io' }] });

      const result = await api.getTURNCredentials('t-turn');
      expect(result.iceServers).toHaveLength(1);
    });
  });

  // ── Reactions extended ─────────────────────────────────────────────────

  describe('getReactions', () => {
    it('fetches reactions', async () => {
      api.addTeam('t-gr', 'https://gr.io');
      api.setToken('t-gr', 'tok');
      globalThis.fetch = mockFetchResponse([{ emoji: '👍', count: 1, users: ['u1'], me: true }]);

      const result = await api.getReactions('t-gr', 'ch1', 'msg1');
      expect(result[0].emoji).toBe('👍');
    });
  });

  // ── Thread management extended ─────────────────────────────────────────

  describe('updateThread', () => {
    it('sends PUT with title', async () => {
      api.addTeam('t-uth', 'https://uth.io');
      api.setToken('t-uth', 'tok');
      globalThis.fetch = mockFetchResponse({});

      await api.updateThread('t-uth', 'th1', 'New Title');
      expect(lastFetchCall().init.method).toBe('PUT');
    });
  });

  describe('deleteThread', () => {
    it('sends DELETE', async () => {
      api.addTeam('t-dth', 'https://dth.io');
      api.setToken('t-dth', 'tok');
      globalThis.fetch = mockFetchResponse({});

      await api.deleteThread('t-dth', 'th1');
      expect(lastFetchCall().init.method).toBe('DELETE');
    });
  });

  // ── enableMockApi ───────────────────────────────────────────────────────

  describe('enableMockApi', () => {
    it('overrides api methods', async () => {
      const { enableMockApi } = await import('./api');
      const mock = {
        checkHealth: vi.fn().mockResolvedValue(true),
      };
      enableMockApi(mock);
      const result = await api.checkHealth('https://mock.io');
      expect(result).toBe(true);
      expect(mock.checkHealth).toHaveBeenCalled();
    });
  });
});
