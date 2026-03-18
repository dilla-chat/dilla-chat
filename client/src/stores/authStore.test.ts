import { describe, it, expect, beforeEach } from 'vitest';
import { useAuthStore } from './authStore';

function getState() {
  return useAuthStore.getState();
}

beforeEach(() => {
  sessionStorage.clear();
  useAuthStore.setState({
    isAuthenticated: false,
    passphrase: null,
    derivedKey: null,
    publicKey: null,
    credentialIds: [],
    teams: new Map(),
    servers: new Map(),
  });
});

describe('setDerivedKey', () => {
  it('persists to sessionStorage and sets isAuthenticated', () => {
    getState().setDerivedKey('test-key-123');
    expect(getState().derivedKey).toBe('test-key-123');
    expect(getState().isAuthenticated).toBe(true);
    expect(sessionStorage.getItem('dilla_derived_key')).toBe('test-key-123');
  });
});

describe('addTeam', () => {
  it('creates team and auto-creates server entry', () => {
    getState().addTeam('team-1', 'token-abc', { id: 'u1' }, { name: 'T1' }, 'https://example.com');

    expect(getState().teams.has('team-1')).toBe(true);
    const team = getState().teams.get('team-1')!;
    expect(team.token).toBe('token-abc');
    expect(team.baseUrl).toBe('https://example.com');

    // Server should exist
    expect(getState().servers.has('example.com')).toBe(true);
    const server = getState().servers.get('example.com')!;
    expect(server.teamIds).toContain('team-1');
  });

  it('persists both teams and servers to sessionStorage', () => {
    getState().addTeam('team-1', 'tok', {}, {}, 'https://test.io');
    expect(sessionStorage.getItem('dilla_teams')).toBeTruthy();
    expect(sessionStorage.getItem('dilla_servers')).toBeTruthy();
  });
});

describe('removeTeam', () => {
  it('removes team and cleans up empty server', () => {
    getState().addTeam('team-1', 'tok', {}, {}, 'https://example.com');
    getState().removeTeam('team-1');

    expect(getState().teams.has('team-1')).toBe(false);
    expect(getState().servers.has('example.com')).toBe(false);
  });

  it('keeps server if other teams remain', () => {
    getState().addTeam('team-1', 'tok1', {}, {}, 'https://example.com');
    getState().addTeam('team-2', 'tok2', {}, {}, 'https://example.com');
    getState().removeTeam('team-1');

    expect(getState().servers.has('example.com')).toBe(true);
    expect(getState().servers.get('example.com')!.teamIds).toEqual(['team-2']);
  });
});

describe('getOrCreateServer', () => {
  it('creates a new server entry', () => {
    const serverId = getState().getOrCreateServer('https://new.server.io', 'alice');
    expect(serverId).toBe('new.server.io');
    expect(getState().servers.get('new.server.io')!.username).toBe('alice');
  });

  it('is idempotent', () => {
    getState().getOrCreateServer('https://s.io');
    getState().getOrCreateServer('https://s.io');
    expect(getState().servers.size).toBe(1);
  });

  it('updates username if provided on existing server', () => {
    getState().getOrCreateServer('https://s.io', 'old');
    getState().getOrCreateServer('https://s.io', 'new');
    expect(getState().servers.get('s.io')!.username).toBe('new');
  });
});

describe('setServerToken', () => {
  it('propagates token to all teams on server', () => {
    getState().addTeam('team-1', 'old', {}, {}, 'https://example.com');
    getState().addTeam('team-2', 'old', {}, {}, 'https://example.com');
    getState().setServerToken('example.com', 'new-token');

    expect(getState().teams.get('team-1')!.token).toBe('new-token');
    expect(getState().teams.get('team-2')!.token).toBe('new-token');
    expect(getState().servers.get('example.com')!.token).toBe('new-token');
  });
});

describe('updateTeamUser', () => {
  it('merges user object', () => {
    getState().addTeam('team-1', 'tok', { id: 'u1', name: 'Alice' }, {}, 'https://e.com');
    getState().updateTeamUser('team-1', { name: 'Alice Updated', avatar: 'new.png' });

    const user = getState().teams.get('team-1')!.user as Record<string, unknown>;
    expect(user.name).toBe('Alice Updated');
    expect(user.avatar).toBe('new.png');
    expect(user.id).toBe('u1');
  });
});

describe('logout', () => {
  it('clears all state and sessionStorage', () => {
    getState().setDerivedKey('key');
    getState().addTeam('team-1', 'tok', {}, {}, 'https://e.com');

    getState().logout();

    expect(getState().isAuthenticated).toBe(false);
    expect(getState().derivedKey).toBeNull();
    expect(getState().teams.size).toBe(0);
    expect(getState().servers.size).toBe(0);
    expect(sessionStorage.getItem('dilla_derived_key')).toBeNull();
    expect(sessionStorage.getItem('dilla_teams')).toBeNull();
    expect(sessionStorage.getItem('dilla_servers')).toBeNull();
  });
});

describe('setPassphrase (legacy)', () => {
  it('sets derivedKey and isAuthenticated', () => {
    getState().setPassphrase('my-passphrase');
    expect(getState().derivedKey).toBe('my-passphrase');
    expect(getState().passphrase).toBe('my-passphrase');
    expect(getState().isAuthenticated).toBe(true);
    expect(sessionStorage.getItem('dilla_derived_key')).toBe('my-passphrase');
  });
});

describe('setPublicKey', () => {
  it('sets public key', () => {
    getState().setPublicKey('pub-key-hex');
    expect(getState().publicKey).toBe('pub-key-hex');
  });
});

describe('setCredentialIds', () => {
  it('sets credential IDs', () => {
    getState().setCredentialIds(['cred-1', 'cred-2']);
    expect(getState().credentialIds).toEqual(['cred-1', 'cred-2']);
  });
});

describe('addTeam without baseUrl', () => {
  it('creates team entry with empty baseUrl', () => {
    getState().addTeam('team-no-url', 'tok', {}, {});
    expect(getState().teams.has('team-no-url')).toBe(true);
    expect(getState().teams.get('team-no-url')!.baseUrl).toBe('');
  });
});

describe('removeTeam with non-existent team', () => {
  it('does not throw', () => {
    expect(() => getState().removeTeam('non-existent')).not.toThrow();
  });
});

describe('updateTeamUser with non-existent team', () => {
  it('does nothing', () => {
    getState().updateTeamUser('non-existent', { name: 'test' });
    expect(getState().teams.size).toBe(0);
  });
});

describe('setServerToken with non-existent server', () => {
  it('does nothing', () => {
    getState().setServerToken('non-existent', 'tok');
    expect(getState().servers.size).toBe(0);
  });
});

describe('removeTeam without serverId', () => {
  it('handles team without serverId', () => {
    getState().addTeam('team-ns', 'tok', {}, {});
    getState().removeTeam('team-ns');
    expect(getState().teams.has('team-ns')).toBe(false);
  });
});
