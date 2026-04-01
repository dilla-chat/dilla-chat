import { describe, it, expect, vi } from 'vitest';
import { saveGroupSession, loadGroupSession, loadAllGroupSessions } from './sessionStore';

// Mock authStore to return null derivedKey (no encryption key available)
vi.mock('../../stores/authStore', () => ({
  useAuthStore: { getState: () => ({ derivedKey: null }) },
}));

describe('sessionStore (no derivedKey)', () => {
  it('loadGroupSession returns null without derivedKey', async () => {
    const result = await loadGroupSession('ch-1');
    expect(result).toBeNull();
  });

  it('loadAllGroupSessions returns empty map without derivedKey', async () => {
    const result = await loadAllGroupSessions();
    expect(result.size).toBe(0);
  });

  it('saveGroupSession is a no-op without derivedKey', async () => {
    // Should not throw
    await saveGroupSession('ch-1', { channelId: 'ch-1', mySenderKey: {} });
  });
});
