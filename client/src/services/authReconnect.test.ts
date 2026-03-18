import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAuthStore } from '../stores/authStore';

vi.mock('./api', () => ({
  api: {
    addTeam: vi.fn(),
    removeTeam: vi.fn(),
    setToken: vi.fn(),
    requestChallenge: vi.fn().mockResolvedValue({ challenge_id: 'ch-1', nonce: 'AAAA' }),
    verifyChallenge: vi.fn().mockResolvedValue({ token: 'jwt-new', user: { id: 'u1' } }),
    listTeams: vi.fn().mockResolvedValue([{ id: 'team-discovered', name: 'Found' }]),
  },
}));

vi.mock('./crypto', () => ({
  getIdentityKeys: vi.fn(() => ({ signingKey: 'mock-key' })),
}));

vi.mock('./keyStore', () => ({
  exportIdentityBlob: vi.fn().mockResolvedValue(null),
  signChallenge: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
}));

vi.mock('./cryptoCore', () => ({
  fromBase64: vi.fn(() => new Uint8Array([0])),
  toBase64: vi.fn(() => 'AQID'),
}));

describe('refreshServerTokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({
      teams: new Map(),
      servers: new Map(),
      isAuthenticated: false,
    });
  });

  it('re-authenticates teams with baseUrl and returns success count', async () => {
    const { refreshServerTokens } = await import('./authReconnect');
    const { api } = await import('./api');

    const teams = new Map([
      ['t1', { token: 'old', user: {}, teamInfo: {}, baseUrl: 'https://server1.com' }],
    ]);

    const count = await refreshServerTokens(teams, 'pubkey123');

    expect(count).toBe(1);
    expect(api.addTeam).toHaveBeenCalledWith('t1', 'https://server1.com');
    expect(api.requestChallenge).toHaveBeenCalledWith('t1', 'pubkey123');
    expect(api.verifyChallenge).toHaveBeenCalled();
    expect(api.setToken).toHaveBeenCalledWith('t1', 'jwt-new');
  });

  it('skips teams without baseUrl', async () => {
    const { refreshServerTokens } = await import('./authReconnect');
    const { api } = await import('./api');

    const teams = new Map([
      ['t1', { token: 'old', user: {}, teamInfo: {}, baseUrl: '' }],
    ]);

    const count = await refreshServerTokens(teams, 'pubkey123');

    expect(count).toBe(0);
    expect(api.requestChallenge).not.toHaveBeenCalled();
  });

  it('removes team on re-auth failure', async () => {
    const { refreshServerTokens } = await import('./authReconnect');
    const { api } = await import('./api');

    vi.mocked(api.requestChallenge).mockRejectedValueOnce(new Error('auth failed'));

    // Add team to store so removeTeam has something to remove
    useAuthStore.getState().addTeam('t-fail', 'old', {}, {}, 'https://fail.com');

    const teams = new Map([
      ['t-fail', { token: 'old', user: {}, teamInfo: {}, baseUrl: 'https://fail.com' }],
    ]);

    const count = await refreshServerTokens(teams, 'pubkey123');

    expect(count).toBe(0);
    expect(api.removeTeam).toHaveBeenCalledWith('t-fail');
  });

  it('uploads identity blob when exportIdentityBlob returns data', async () => {
    const { refreshServerTokens } = await import('./authReconnect');
    const { exportIdentityBlob } = await import('./keyStore');

    vi.mocked(exportIdentityBlob).mockResolvedValueOnce('base64blob');
    global.fetch = vi.fn().mockResolvedValue({ ok: true });

    const teams = new Map([
      ['t1', { token: 'old', user: {}, teamInfo: {}, baseUrl: 'https://server.com' }],
    ]);

    await refreshServerTokens(teams, 'pubkey123');

    expect(global.fetch).toHaveBeenCalledWith(
      'https://server.com/api/v1/identity/blob',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('handles blob upload failure gracefully', async () => {
    const { refreshServerTokens } = await import('./authReconnect');
    const { exportIdentityBlob } = await import('./keyStore');

    vi.mocked(exportIdentityBlob).mockResolvedValueOnce('base64blob');
    global.fetch = vi.fn().mockRejectedValue(new Error('network'));

    const teams = new Map([
      ['t1', { token: 'old', user: {}, teamInfo: {}, baseUrl: 'https://server.com' }],
    ]);

    // Should not throw
    const count = await refreshServerTokens(teams, 'pubkey123');
    expect(count).toBe(1);
  });

  it('handles multiple teams with mixed success/failure', async () => {
    const { refreshServerTokens } = await import('./authReconnect');
    const { api } = await import('./api');

    vi.mocked(api.requestChallenge)
      .mockResolvedValueOnce({ challenge_id: 'ch-1', nonce: 'AAAA' })
      .mockRejectedValueOnce(new Error('fail'));

    const teams = new Map([
      ['t1', { token: 'old', user: {}, teamInfo: {}, baseUrl: 'https://good.com' }],
      ['t2', { token: 'old', user: {}, teamInfo: {}, baseUrl: 'https://bad.com' }],
    ]);

    const count = await refreshServerTokens(teams, 'pubkey123');
    expect(count).toBe(1);
  });
});

describe('tryReconnectToCurrentServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({
      teams: new Map(),
      servers: new Map(),
      isAuthenticated: false,
    });
  });

  it('discovers teams on the current server and adds them', async () => {
    const { tryReconnectToCurrentServer } = await import('./authReconnect');
    const { api } = await import('./api');

    const result = await tryReconnectToCurrentServer('pubkey123');

    expect(result).toBe(true);
    expect(api.addTeam).toHaveBeenCalledWith('__reconnect__', expect.any(String));
    expect(api.listTeams).toHaveBeenCalled();
    expect(api.removeTeam).toHaveBeenCalledWith('__reconnect__');
    expect(useAuthStore.getState().teams.size).toBeGreaterThan(0);
  });

  it('returns false when no teams are discovered', async () => {
    const { tryReconnectToCurrentServer } = await import('./authReconnect');
    const { api } = await import('./api');

    vi.mocked(api.listTeams).mockResolvedValueOnce([]);

    const result = await tryReconnectToCurrentServer('pubkey123');
    expect(result).toBe(false);
  });

  it('returns false and cleans up on error', async () => {
    const { tryReconnectToCurrentServer } = await import('./authReconnect');
    const { api } = await import('./api');

    vi.mocked(api.requestChallenge).mockRejectedValueOnce(new Error('offline'));

    const result = await tryReconnectToCurrentServer('pubkey123');
    expect(result).toBe(false);
    expect(api.removeTeam).toHaveBeenCalledWith('__reconnect__');
  });

  it('skips teams without id', async () => {
    const { tryReconnectToCurrentServer } = await import('./authReconnect');
    const { api } = await import('./api');

    vi.mocked(api.listTeams).mockResolvedValueOnce([{ name: 'no-id' }]);

    const result = await tryReconnectToCurrentServer('pubkey123');
    expect(result).toBe(false);
  });
});
