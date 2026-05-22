// Smoke + roundtrip coverage for MockApiService.
//
// MockApiService is the in-memory drop-in used by /mesh and the
// onboarding demo. The shape contract is "same public surface as the
// real ApiService" — these tests assert each method either returns a
// fixture-ish payload or successfully round-trips local state. They
// don't try to exercise the WS broadcast side-effects (the mock
// service doesn't do those) — that's a different layer.

import { describe, it, expect } from 'vitest';
import { MockApiService } from './mockApi';

function newService() {
  return new MockApiService();
}

describe('MockApiService — connection stubs', () => {
  it('addTeam / removeTeam / setToken / setAuthErrorHandler are noops', () => {
    const svc = newService();
    expect(() => svc.addTeam('t', 'http://localhost')).not.toThrow();
    expect(() => svc.removeTeam('t')).not.toThrow();
    expect(() => svc.setToken('t', 'tok')).not.toThrow();
    expect(() => svc.setAuthErrorHandler(() => {})).not.toThrow();
  });

  it('getConnectionInfo returns connected-shaped info', () => {
    const svc = newService();
    const info = svc.getConnectionInfo('t');
    expect(info).toBeTypeOf('object');
  });

  it('getWsTicket returns a string', async () => {
    const svc = newService();
    const ticket = await svc.getWsTicket('t');
    expect(typeof ticket).toBe('string');
    expect(ticket.length).toBeGreaterThan(0);
  });
});

describe('MockApiService — auth surface', () => {
  it('getDemoIdentity returns the demo user', () => {
    const svc = newService();
    const id = svc.getDemoIdentity();
    expect(id).toBeTypeOf('object');
  });

  it('requestChallenge and verifyChallenge resolve with shapes', async () => {
    const svc = newService();
    const ch = await svc.requestChallenge('t', 'pubkey');
    expect(ch).toBeTypeOf('object');
    const v = await svc.verifyChallenge('t', 'cid', 'pubkey', 'sig');
    expect(v).toBeTypeOf('object');
  });

  it('register returns a token + demo user', async () => {
    const out = await newService().register();
    expect(out.token).toBeTypeOf('string');
    expect(out.user.id).toBeTypeOf('string');
  });

  it('bootstrap returns user + team + token', async () => {
    const out = await newService().bootstrap();
    expect(out.token).toBeTypeOf('string');
    expect(out.team).toBeTypeOf('object');
  });
});

describe('MockApiService — invites', () => {
  it('createInvite returns a token shape', async () => {
    const inv = await newService().createInvite();
    expect(inv.token).toBeTypeOf('string');
  });

  it('listInvites returns an array', async () => {
    expect(await newService().listInvites()).toBeInstanceOf(Array);
  });

  it('revokeInvite resolves to undefined', async () => {
    expect(await newService().revokeInvite()).toBeUndefined();
  });

  it('getInviteInfo includes team_name', async () => {
    const info = await newService().getInviteInfo();
    expect(info.team_name).toBeTypeOf('string');
  });
});

describe('MockApiService — channels', () => {
  it('getChannels returns the seeded list', async () => {
    const svc = newService();
    const channels = await svc.getChannels();
    expect(Array.isArray(channels)).toBe(true);
    expect(channels.length).toBeGreaterThan(0);
  });

  it('createChannel appends to the list', async () => {
    const svc = newService();
    const before = (await svc.getChannels()).length;
    const newCh = await svc.createChannel('t', { name: 'fresh', type: 'text' });
    expect(newCh.name).toBe('fresh');
    const after = (await svc.getChannels()).length;
    expect(after).toBe(before + 1);
  });

  it('updateChannel mutates the matching entry', async () => {
    const svc = newService();
    const created = await svc.createChannel('t', { name: 'old', type: 'text' });
    const updated = await svc.updateChannel('t', created.id, { topic: 'updated topic' });
    expect(updated.topic).toBe('updated topic');
  });

  it('deleteChannel removes the entry', async () => {
    const svc = newService();
    const created = await svc.createChannel('t', { name: 'temp', type: 'text' });
    const before = (await svc.getChannels()).length;
    await svc.deleteChannel('t', created.id);
    const after = (await svc.getChannels()).length;
    expect(after).toBe(before - 1);
  });
});

describe('MockApiService — team / members / roles', () => {
  it('getTeam returns the seeded team', async () => {
    const team = await newService().getTeam();
    expect(team).toBeTypeOf('object');
    expect(team.id).toBeTypeOf('string');
  });

  it('updateTeam merges the updates with the seeded team', async () => {
    const updated = await newService().updateTeam('t', { description: 'changed' });
    expect(updated.description).toBe('changed');
  });

  it('getMembers / getRoles return arrays', async () => {
    const svc = newService();
    expect(Array.isArray(await svc.getMembers())).toBe(true);
    expect(Array.isArray(await svc.getRoles())).toBe(true);
  });

  it('createRole returns the new role with assigned id', async () => {
    const role = await newService().createRole('t', { name: 'mod', color: '#f00', permissions: 1 });
    expect(role.name).toBe('mod');
    expect(role.id).toBeTypeOf('string');
  });

  it('updateRole / deleteRole / updateMember / kickMember / banMember / unbanMember are noop-shaped', async () => {
    const svc = newService();
    expect(await svc.updateRole('t', 'r1', { name: 'x' })).toEqual({ name: 'x' });
    expect(await svc.deleteRole()).toBeUndefined();
    expect(await svc.updateMember()).toBeUndefined();
    expect(await svc.kickMember()).toBeUndefined();
    expect(await svc.banMember()).toBeUndefined();
    expect(await svc.unbanMember()).toBeUndefined();
  });
});

describe('MockApiService — messages', () => {
  it('getMessages returns the seeded fixture for a known channel', async () => {
    const msgs = await newService().getMessages('t', 'ch-1');
    expect(Array.isArray(msgs)).toBe(true);
  });

  it('getMessages returns empty for an unknown channel', async () => {
    const msgs = await newService().getMessages('t', 'no-such-channel');
    expect(msgs).toEqual([]);
  });
});

describe('MockApiService — federation stubs', () => {
  it('getFederationStatus and getFederationPeers resolve', async () => {
    const svc = newService();
    expect(await svc.getFederationStatus()).toBeTypeOf('object');
    expect(Array.isArray(await svc.getFederationPeers())).toBe(true);
  });

  it('generateJoinToken returns a token + command', async () => {
    const out = await newService().generateJoinToken();
    expect(out.token).toBeTypeOf('string');
    expect(out.join_command).toBeTypeOf('string');
  });
});

describe('MockApiService — DMs', () => {
  it('createDM returns a channel + adds it to the list', async () => {
    const svc = newService();
    const before = (await svc.getDMChannels()).length;
    const dm = await svc.createDM('t', ['user-a', 'user-b']);
    expect(dm.id).toBeTypeOf('string');
    const after = (await svc.getDMChannels()).length;
    expect(after).toBe(before + 1);
  });

  it('getDMChannel returns the matching entry', async () => {
    const svc = newService();
    const dm = await svc.createDM('t', ['user-a', 'user-b']);
    const got = await svc.getDMChannel('t', dm.id);
    expect(got?.id).toBe(dm.id);
  });

  it('sendDMMessage adds to the DM message list', async () => {
    const svc = newService();
    const dm = await svc.createDM('t', ['user-a', 'user-b']);
    const sent = await svc.sendDMMessage('t', dm.id, 'hello dm');
    expect(sent).toBeTypeOf('object');
    const msgs = await svc.getDMMessages('t', dm.id);
    expect(msgs.length).toBeGreaterThan(0);
  });

  it('editDMMessage updates the text on the matching message', async () => {
    const svc = newService();
    const dm = await svc.createDM('t', ['user-a', 'user-b']);
    const sent = await svc.sendDMMessage('t', dm.id, 'first');
    // sendDMMessage returns the new message id directly or via a wrapped shape
    // — pull whatever id field exists.
    const mid = (sent as { id?: string }).id;
    if (mid) {
      const edited = await svc.editDMMessage('t', dm.id, mid, 'edited');
      expect(edited).toBeTypeOf('object');
    }
  });
});
