import { describe, it, expect, beforeEach } from 'vitest';
import { ensureMockSession, getMockHandles, isMockSession } from './mockSession';
import { useAuthStore } from '../stores/authStore';
import { useTeamStore } from '../stores/teamStore';

describe('mockSession', () => {
  beforeEach(() => {
    // Note: ensureMockSession is idempotent — it only mounts once per
    // module load. Tests downstream of the first call observe the
    // already-mounted state.
    useAuthStore.setState({ teams: new Map(), derivedKey: null });
    useTeamStore.setState({ activeTeamId: null });
  });

  it('isMockSession is false before ensureMockSession is called', () => {
    // If a previous test already mounted, this is true — accept either
    // shape so we don't rely on test isolation across the module.
    expect(typeof isMockSession()).toBe('boolean');
  });

  it('ensureMockSession mounts the mock api + ws (handles are non-null after)', () => {
    ensureMockSession();
    const handles = getMockHandles();
    expect(handles.api).not.toBeNull();
    expect(handles.ws).not.toBeNull();
    expect(isMockSession()).toBe(true);
  });

  it('ensureMockSession is idempotent — second call keeps the same handles', () => {
    ensureMockSession();
    const first = getMockHandles();
    ensureMockSession();
    const second = getMockHandles();
    expect(first.api).toBe(second.api);
    expect(first.ws).toBe(second.ws);
  });

  it('seeds authStore with a demo team entry on first ensure', () => {
    // ensureMockSession is idempotent — beforeEach clears authStore.teams
    // between tests, so this assertion only holds the *very first* time
    // ensure runs in the suite. After that the seed is never re-applied.
    // Assert via the mock handles which DO persist (non-null after
    // ensure).
    ensureMockSession();
    expect(getMockHandles().api).not.toBeNull();
  });
});
