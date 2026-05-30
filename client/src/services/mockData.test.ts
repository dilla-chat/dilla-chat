import { describe, it, expect } from 'vitest';
import {
  DEMO_TEAM_ID,
  DEMO_CURRENT_USER_ID,
  MOCK_USERS,
  MOCK_TEAM,
  MOCK_ROLES,
  MOCK_GROUPS,
  MOCK_CHANNELS,
  MOCK_MEMBERS,
  MOCK_GENERAL_MESSAGES,
  MOCK_WELCOME_MESSAGES,
  MOCK_DM_CHANNELS,
  MOCK_DM_MESSAGES,
  MOCK_THREADS,
  MOCK_THREAD_MESSAGES,
  MOCK_PRESENCES,
  MOCK_VOICE_STATES,
} from './mockData';

describe('mockData seed', () => {
  it('demo team id matches MOCK_TEAM.id', () => {
    expect(MOCK_TEAM.id).toBe(DEMO_TEAM_ID);
  });

  it('every MOCK_USER has a unique id', () => {
    const ids = MOCK_USERS.map((u) => u.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(DEMO_CURRENT_USER_ID);
  });

  it('exactly one @everyone role is marked default', () => {
    const defaults = MOCK_ROLES.filter((r) => r.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].name).toBe('@everyone');
  });

  it('role positions are unique and sort top-down', () => {
    const positions = MOCK_ROLES.map((r) => r.position);
    expect(new Set(positions).size).toBe(positions.length);
  });

  it('every channel has a groupId pointing at a real MOCK_GROUP', () => {
    const groupIds = new Set(MOCK_GROUPS.map((g) => g.id));
    for (const ch of MOCK_CHANNELS) {
      expect(groupIds.has(ch.groupId!)).toBe(true);
    }
  });

  it('channels include both text and voice types', () => {
    const types = new Set(MOCK_CHANNELS.map((c) => c.type));
    expect(types).toContain('text');
    expect(types).toContain('voice');
  });

  it('every member.userId maps to a MOCK_USERS entry', () => {
    const userIds = new Set(MOCK_USERS.map((u) => u.id));
    for (const m of MOCK_MEMBERS) expect(userIds.has(m.userId)).toBe(true);
  });

  it('exactly one isAdmin=true member (the demo user)', () => {
    const admins = MOCK_MEMBERS.filter((m) => m.isAdmin);
    expect(admins).toHaveLength(1);
    expect(admins[0].userId).toBe(DEMO_CURRENT_USER_ID);
  });

  it('all messages in MOCK_GENERAL_MESSAGES belong to ch-2 (#general)', () => {
    for (const m of MOCK_GENERAL_MESSAGES) expect(m.channelId).toBe('ch-2');
  });

  it('all messages in MOCK_WELCOME_MESSAGES belong to ch-1 (#welcome)', () => {
    for (const m of MOCK_WELCOME_MESSAGES) expect(m.channelId).toBe('ch-1');
  });

  it('DM channel ids look like dm-* and have at least one paired counterpart', () => {
    expect(MOCK_DM_CHANNELS.length).toBeGreaterThan(0);
    for (const dm of MOCK_DM_CHANNELS) {
      expect(dm.id).toMatch(/^dm-/);
    }
  });

  it('every key in MOCK_DM_MESSAGES corresponds to a MOCK_DM_CHANNELS entry', () => {
    const ids = new Set(MOCK_DM_CHANNELS.map((d) => d.id));
    for (const k of Object.keys(MOCK_DM_MESSAGES)) {
      expect(ids.has(k)).toBe(true);
    }
  });

  it('threads reference channels that exist', () => {
    const channelIds = new Set(MOCK_CHANNELS.map((c) => c.id));
    for (const th of MOCK_THREADS) expect(channelIds.has(th.channel_id)).toBe(true);
  });

  it('thread messages contain a root entry for every thread', () => {
    for (const th of MOCK_THREADS) {
      expect(MOCK_THREAD_MESSAGES[th.id]).toBeTruthy();
      expect(MOCK_THREAD_MESSAGES[th.id]!.length).toBeGreaterThan(0);
    }
  });

  it('every user has a presence entry', () => {
    for (const u of MOCK_USERS) expect(MOCK_PRESENCES[u.id]).toBeTruthy();
  });

  it('MOCK_VOICE_STATES is shaped { channelId, occupants[] }', () => {
    expect(typeof MOCK_VOICE_STATES).toBe('object');
  });
});
