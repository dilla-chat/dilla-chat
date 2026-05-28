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

  it('deleteDMMessage + addDMMembers + removeDMMember are reachable', async () => {
    const svc = newService();
    const dm = await svc.createDM('t', ['user-a', 'user-b']);
    const sent = await svc.sendDMMessage('t', dm.id, 'soon-to-delete');
    const mid = (sent as { id?: string }).id;
    if (mid) await svc.deleteDMMessage('t', dm.id, mid);
    expect(await svc.addDMMembers()).toBeUndefined();
    expect(await svc.removeDMMember()).toBeUndefined();
  });
});

describe('MockApiService — threads', () => {
  it('createThread + getChannelThreads + getThread', async () => {
    const svc = newService();
    const t = await svc.createThread('t', 'ch-1', 'msg-1', 'topic');
    expect(t).toBeTypeOf('object');
    expect(Array.isArray(await svc.getChannelThreads('t', 'ch-1'))).toBe(true);
    const got = await svc.getThread('t', (t as { id: string }).id);
    expect(got).toBeTypeOf('object');
  });

  it('updateThread + deleteThread', async () => {
    const svc = newService();
    const t = await svc.createThread('t', 'ch-1', 'msg-1');
    const id = (t as { id: string }).id;
    const updated = await svc.updateThread('t', id, 'new title');
    expect(updated).toBeDefined();
    await svc.deleteThread('t', id);
    const after = await svc.getThread('t', id);
    expect(after).toBeFalsy();
  });

  it('thread messages CRUD', async () => {
    const svc = newService();
    const t = await svc.createThread('t', 'ch-1', 'msg-1');
    const tid = (t as { id: string }).id;
    expect(Array.isArray(await svc.getThreadMessages('t', tid))).toBe(true);
    const sent = await svc.sendThreadMessage('t', tid, 'hi');
    const sid = (sent as { id?: string }).id;
    if (sid) {
      await svc.editThreadMessage('t', tid, sid, 'edited');
      await svc.deleteThreadMessage('t', tid, sid);
    }
  });
});

describe('MockApiService — reactions / attachments', () => {
  it('add/remove/get reactions', async () => {
    const svc = newService();
    await svc.addReaction('t', 'ch-1', 'm1', '👍');
    await svc.removeReaction('t', 'ch-1', 'm1', '👍');
    const r = await svc.getReactions('t', 'ch-1', 'm1');
    expect(Array.isArray(r)).toBe(true);
  });

  it('addReaction → toggles existing emoji count + getReactions surfaces it', async () => {
    const svc = newService();
    const msg = {
      id: 'msg-react',
      channel_id: 'ch-react',
      sender_id: 'demo',
      username: 'demo',
      content: 'hi',
      reactions: [] as { emoji: string; users: string[]; count: number }[],
      attachments: [],
      created_at: new Date().toISOString(),
      edited_at: null,
      deleted: false,
    };
    (svc as unknown as { _addChannelMessage: (c: string, m: typeof msg) => void })._addChannelMessage('ch-react', msg);

    await svc.addReaction('t', 'ch-react', 'msg-react', '🔥');
    let r = await svc.getReactions('t', 'ch-react', 'msg-react');
    expect(r[0].emoji).toBe('🔥');
    expect(r[0].count).toBe(1);
    expect(r[0].me).toBe(true);

    // Same emoji again from the same user — no count bump
    await svc.addReaction('t', 'ch-react', 'msg-react', '🔥');
    r = await svc.getReactions('t', 'ch-react', 'msg-react');
    expect(r[0].count).toBe(1);

    // Remove — emoji entry deletes when count hits zero
    await svc.removeReaction('t', 'ch-react', 'msg-react', '🔥');
    r = await svc.getReactions('t', 'ch-react', 'msg-react');
    expect(r).toEqual([]);
  });

  it('removeReaction on a missing emoji is a no-op', async () => {
    const svc = newService();
    const msg = {
      id: 'msg-nope', channel_id: 'ch-nope', sender_id: 'd', username: 'd',
      content: '', reactions: [], attachments: [], created_at: '', edited_at: null, deleted: false,
    };
    (svc as unknown as { _addChannelMessage: (c: string, m: typeof msg) => void })._addChannelMessage('ch-nope', msg);
    await svc.removeReaction('t', 'ch-nope', 'msg-nope', '🤷');
    expect(await svc.getReactions('t', 'ch-nope', 'msg-nope')).toEqual([]);
  });

  it('uploadFile + getAttachmentUrl + deleteAttachment', async () => {
    const svc = newService();
    const att = await svc.uploadFile();
    expect(att).toBeTypeOf('object');
    expect(svc.getAttachmentUrl()).toBe('');
    await svc.deleteAttachment();
  });
});

describe('MockApiService — presence + voice', () => {
  it('getPresences + getUserPresence + updatePresence', async () => {
    const svc = newService();
    expect(await svc.getPresences()).toBeTypeOf('object');
    expect(await svc.getUserPresence('t', 'me')).toBeTypeOf('object');
    await svc.updatePresence();
  });

  it('getVoiceState + joinVoice + leaveVoice', async () => {
    const svc = newService();
    expect(await svc.getVoiceState('t', 'ch-voice')).toBeTypeOf('object');
    expect(await svc.joinVoice('t', 'ch-voice')).toBeTypeOf('object');
    await svc.leaveVoice();
  });
});

describe('MockApiService — polls', () => {
  it('list / create / vote / unvote', async () => {
    const svc = newService();
    expect(Array.isArray(await svc.getPolls('t', 'ch-1'))).toBe(true);
    const created = (await svc.createPoll('t', 'ch-1', { question: 'Q?', options: ['a', 'b'] })) as { id?: string };
    expect(created).toBeTypeOf('object');
    const pid = created.id ?? 'p1';
    await svc.votePoll('t', pid, 0);
    await svc.unvotePoll('t', pid);
  });
});

describe('MockApiService — mute / unmute', () => {
  it('mute + unmute channel', async () => {
    const svc = newService();
    const muted = await svc.muteChannel('t', 'ch-1');
    expect(muted).toBeTypeOf('object');
    await svc.muteChannel('t', 'ch-1', new Date().toISOString());
    await svc.unmuteChannel('t', 'ch-1');
  });
});

describe('MockApiService — giphy', () => {
  it('embedGif + searchGif', async () => {
    const svc = newService();
    expect(await svc.embedGif('t', 'https://example/gif')).toBeTypeOf('object');
    expect(await svc.searchGif('t', 'cat', 10)).toBeTypeOf('object');
  });

  it('getGiphyIntegration + setGiphyApiKey', async () => {
    const svc = newService();
    expect(await svc.getGiphyIntegration('t')).toBeTypeOf('object');
    expect(await svc.setGiphyApiKey('t', 'gph_key')).toBeTypeOf('object');
  });
});

describe('MockApiService — blocks / pins / groups', () => {
  it('list / block / unblock', async () => {
    const svc = newService();
    expect(await svc.listBlocks('t')).toBeInstanceOf(Array);
    await svc.blockUser('t', 'u2');
    await svc.unblockUser('t', 'u2');
  });

  it('pin / unpin message', async () => {
    const svc = newService() as unknown as { pins: Map<string, string[]>; pinMessage: (t: string, c: string, m: string) => Promise<void>; unpinMessage: (t: string, c: string, m: string) => Promise<void> };
    await svc.pinMessage('t', 'ch-1', 'm1');
    expect(svc.pins.get('ch-1')).toContain('m1');
    await svc.unpinMessage('t', 'ch-1', 'm1');
    expect(svc.pins.get('ch-1') ?? []).not.toContain('m1');
  });

  it('groups CRUD + setGroupAccess', async () => {
    const svc = newService();
    const groups = await svc.listGroups('t');
    expect(Array.isArray(groups)).toBe(true);
    const created = await svc.createGroup('t', 'newgrp');
    expect(created.id).toBeTruthy();
    const updated = await svc.updateGroup('t', created.id, { name: 'renamed', position: 2 });
    expect(updated).toBeTypeOf('object');
    const access = await svc.setGroupAccess('t', created.id, ['r1'], true);
    expect(access.role_ids).toEqual(['r1']);
    await svc.deleteGroup('t', created.id);
  });
});

describe('MockApiService — health + leave', () => {
  it('leaveTeam is a noop', async () => {
    await expect(newService().leaveTeam('t')).resolves.toBeUndefined();
  });

  it('checkHealth returns true', async () => {
    expect(await newService().checkHealth()).toBe(true);
  });
});
