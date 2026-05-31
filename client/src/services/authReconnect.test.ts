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
    uploadRecoverySlot: vi.fn().mockResolvedValue(undefined),
  },
  // H-13d: cross-origin in this test (page is on jsdom http://localhost,
  // baseUrl is https://server.com), so the bearer header is still
  // attached. Returning false matches that runtime branch.
  isSameOriginAsApi: vi.fn(() => false),
}));

vi.mock('./crypto', () => ({
  getIdentityKeys: vi.fn(() => ({ signingKey: 'mock-key' })),
}));

vi.mock('./keyStore', () => ({
  exportIdentityBlob: vi.fn().mockResolvedValue(null),
  signChallenge: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
  hasPasskeyKeySlot: vi.fn().mockResolvedValue(false),
  listEscrowableCredentialDescriptors: vi.fn().mockResolvedValue([]),
  buildRecoveryEscrowBlob: vi.fn().mockResolvedValue(new Uint8Array([9, 9, 9])),
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
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });

    const teams = new Map([
      ['t1', { token: 'old', user: {}, teamInfo: {}, baseUrl: 'https://server.com' }],
    ]);

    await refreshServerTokens(teams, 'pubkey123');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://server.com/api/v1/identity/blob',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('handles blob upload failure gracefully', async () => {
    const { refreshServerTokens } = await import('./authReconnect');
    const { exportIdentityBlob } = await import('./keyStore');

    vi.mocked(exportIdentityBlob).mockResolvedValueOnce('base64blob');
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network'));

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

  it('returns false when verifyChallenge rejects (unknown public key)', async () => {
    const { tryReconnectToCurrentServer } = await import('./authReconnect');
    const { api } = await import('./api');

    vi.mocked(api.verifyChallenge).mockRejectedValueOnce(
      new Error('no account found for this public key — register first'),
    );

    const result = await tryReconnectToCurrentServer('unknown-pubkey');
    expect(result).toBe(false);
    expect(api.removeTeam).toHaveBeenCalledWith('__reconnect__');
  });
});

describe('refreshServerTokens after auth error cleared teams', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({
      teams: new Map(),
      servers: new Map(),
      isAuthenticated: false,
    });
  });

  it('returns 0 when teams map is empty (auth error previously cleared it)', async () => {
    const { refreshServerTokens } = await import('./authReconnect');
    const { api } = await import('./api');

    const emptyTeams = new Map();
    const count = await refreshServerTokens(emptyTeams, 'pubkey123');

    expect(count).toBe(0);
    expect(api.requestChallenge).not.toHaveBeenCalled();
  });

  it('removes team when verifyChallenge returns 401 (unknown key after server reset)', async () => {
    const { refreshServerTokens } = await import('./authReconnect');
    const { api } = await import('./api');

    vi.mocked(api.verifyChallenge).mockRejectedValueOnce(
      new Error('no account found for this public key — register first'),
    );

    useAuthStore.getState().addTeam('t-stale', 'old-jwt', {}, {}, 'https://server.com');

    const teams = new Map([
      ['t-stale', { token: 'old-jwt', user: {}, teamInfo: {}, baseUrl: 'https://server.com' }],
    ]);

    const count = await refreshServerTokens(teams, 'new-pubkey');

    expect(count).toBe(0);
    expect(api.removeTeam).toHaveBeenCalledWith('t-stale');
    expect(useAuthStore.getState().teams.has('t-stale')).toBe(false);
  });

  // ─── Passkey-recoverable identity escrow (design doc 15) ───────────────

  describe('uploadPasskeyRecoverySlots (via refreshServerTokens)', () => {
    it('skips upload for passphrase-only users', async () => {
      const { refreshServerTokens } = await import('./authReconnect');
      const { api } = await import('./api');
      const { hasPasskeyKeySlot } = await import('./keyStore');
      vi.mocked(hasPasskeyKeySlot).mockResolvedValueOnce(false);
      useAuthStore.setState({
        teams: new Map([['t1', { token: 'jwt', user: {}, teamInfo: {}, baseUrl: 'https://server.com' }]]),
        derivedKey: 'cHJmLW91dHB1dA==',
      });
      const teams = new Map([
        ['t1', { token: 'jwt', user: {}, teamInfo: {}, baseUrl: 'https://server.com' }],
      ]);
      await refreshServerTokens(teams, 'pubkey');
      expect(api.uploadRecoverySlot).not.toHaveBeenCalled();
    });

    it('skips upload when no derivedKey is available (lock screen)', async () => {
      const { refreshServerTokens } = await import('./authReconnect');
      const { api } = await import('./api');
      const { hasPasskeyKeySlot } = await import('./keyStore');
      vi.mocked(hasPasskeyKeySlot).mockResolvedValueOnce(true);
      useAuthStore.setState({
        teams: new Map([['t1', { token: 'jwt', user: {}, teamInfo: {}, baseUrl: 'https://server.com' }]]),
        derivedKey: '', // empty → skip
      });
      const teams = new Map([
        ['t1', { token: 'jwt', user: {}, teamInfo: {}, baseUrl: 'https://server.com' }],
      ]);
      await refreshServerTokens(teams, 'pubkey');
      expect(api.uploadRecoverySlot).not.toHaveBeenCalled();
    });

    it('uploads one slot per (team, credential) when descriptors exist', async () => {
      const { refreshServerTokens } = await import('./authReconnect');
      const { api } = await import('./api');
      const { hasPasskeyKeySlot, listEscrowableCredentialDescriptors } = await import('./keyStore');
      vi.mocked(hasPasskeyKeySlot).mockResolvedValueOnce(true);
      vi.mocked(listEscrowableCredentialDescriptors).mockResolvedValueOnce([
        { credentialId: 'cred-a', prfSalt: new Uint8Array([1, 2, 3]) },
        { credentialId: 'cred-b', prfSalt: new Uint8Array([4, 5, 6]) },
      ]);
      useAuthStore.setState({
        teams: new Map([
          ['t1', { token: 'jwt-1', user: {}, teamInfo: {}, baseUrl: 'https://server.com' }],
        ]),
        derivedKey: 'cHJm',
      });
      const teams = new Map([
        ['t1', { token: 'jwt-1', user: {}, teamInfo: {}, baseUrl: 'https://server.com' }],
      ]);
      await refreshServerTokens(teams, 'pubkey');
      // 2 credentials × 1 team
      expect(api.uploadRecoverySlot).toHaveBeenCalledTimes(2);
      const credIds = vi.mocked(api.uploadRecoverySlot).mock.calls.map(c => (c[1] as { credential_id: string }).credential_id);
      expect(credIds.sort()).toEqual(['cred-a', 'cred-b']);
    });

    it('swallows per-credential upload errors so login still succeeds', async () => {
      const { refreshServerTokens } = await import('./authReconnect');
      const { api } = await import('./api');
      const { hasPasskeyKeySlot, listEscrowableCredentialDescriptors } = await import('./keyStore');
      vi.mocked(hasPasskeyKeySlot).mockResolvedValueOnce(true);
      vi.mocked(listEscrowableCredentialDescriptors).mockResolvedValueOnce([
        { credentialId: 'cred-bad', prfSalt: new Uint8Array([1]) },
      ]);
      vi.mocked(api.uploadRecoverySlot).mockRejectedValueOnce(new Error('500 from old server'));
      useAuthStore.setState({
        teams: new Map([
          ['t1', { token: 'jwt-1', user: {}, teamInfo: {}, baseUrl: 'https://server.com' }],
        ]),
        derivedKey: 'cHJm',
      });
      const teams = new Map([
        ['t1', { token: 'jwt-1', user: {}, teamInfo: {}, baseUrl: 'https://server.com' }],
      ]);
      // Should not throw — best-effort upload swallows failures.
      await expect(refreshServerTokens(teams, 'pubkey')).resolves.not.toThrow();
    });
  });
});
