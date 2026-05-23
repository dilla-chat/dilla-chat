import { describe, it, expect } from 'vitest';
import { EMPTY_SHELL_DATA } from './data';

describe('shell/data EMPTY_SHELL_DATA', () => {
  it('exposes the eight empty fields the shell expects as a fallback', () => {
    expect(EMPTY_SHELL_DATA.SERVERS).toEqual([]);
    expect(EMPTY_SHELL_DATA.MEMBERS).toEqual([]);
    expect(EMPTY_SHELL_DATA.byId).toEqual({});
    expect(EMPTY_SHELL_DATA.CHANNELS).toEqual([]);
    expect(EMPTY_SHELL_DATA.MESSAGES).toEqual({});
    expect(EMPTY_SHELL_DATA.DMS).toEqual([]);
    expect(EMPTY_SHELL_DATA.DM_MESSAGES).toEqual({});
    expect(EMPTY_SHELL_DATA.THREAD_REPLIES).toEqual({});
  });

  it('every collection is empty (no rogue seed data leaks into /app)', () => {
    // The whole point of this module post-refactor — see the comment in
    // shell/data.ts. If anyone re-adds fixture content here, this fails.
    expect(EMPTY_SHELL_DATA.SERVERS.length).toBe(0);
    expect(EMPTY_SHELL_DATA.MEMBERS.length).toBe(0);
    expect(EMPTY_SHELL_DATA.CHANNELS.length).toBe(0);
    expect(EMPTY_SHELL_DATA.DMS.length).toBe(0);
    expect(Object.keys(EMPTY_SHELL_DATA.byId)).toEqual([]);
    expect(Object.keys(EMPTY_SHELL_DATA.MESSAGES)).toEqual([]);
    expect(Object.keys(EMPTY_SHELL_DATA.DM_MESSAGES)).toEqual([]);
    expect(Object.keys(EMPTY_SHELL_DATA.THREAD_REPLIES)).toEqual([]);
  });
});
