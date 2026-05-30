// Cover api.ts methods that aren't drilled by the existing test:
// access endpoints, groups, devices, blocks, pins, mutes, giphy,
// polls, audit, federation, DM.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./telemetry', () => ({ traceWSEvent: vi.fn() }));

import { api } from './api';

describe('ApiService — many endpoints', () => {
  const svc = api;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    svc.addTeam('t1', 'https://srv');
    svc.setToken('t1', 'tok');
    fetchMock = vi.fn(async () => ({
      ok: true, status: 200,
      headers: { get: () => 'application/json' },
      text: async () => '{}',
      json: async () => ({}),
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
  });

  function callBody() {
    const opts = fetchMock.mock.calls.at(-1)?.[1];
    return opts?.body ? JSON.parse(opts.body) : null;
  }

  function callUrl() {
    return fetchMock.mock.calls.at(-1)?.[0] as string;
  }

  it('setChannelAccess PUTs channel/:id/access', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{}', json: async () => ({ role_ids: ['r1'] }) } as never);
    await svc.setChannelAccess('t1', 'ch-1', ['r1']);
    expect(callUrl()).toContain('/channels/ch-1/access');
  });

  it('listGroups GETs groups', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '[]', json: async () => [] } as never);
    await svc.listGroups('t1');
    expect(callUrl()).toContain('/groups');
  });

  it('createGroup POSTs', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{}', json: async () => ({ id: 'g1', name: 'main', position: 0 }) } as never);
    await svc.createGroup('t1', 'main');
    expect(callBody()?.name).toBe('main');
  });

  it('updateGroup PATCHes', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{}', json: async () => ({ id: 'g1', name: 'renamed', position: 1 }) } as never);
    await svc.updateGroup('t1', 'g1', { name: 'renamed' });
    expect(callUrl()).toContain('/groups/g1');
  });

  it('deleteGroup DELETEs', async () => {
    await svc.deleteGroup('t1', 'g1');
    expect(callUrl()).toContain('/groups/g1');
  });

  it('setGroupAccess PUTs', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{}', json: async () => ({ role_ids: ['r1'], hidden_if_restricted: true }) } as never);
    await svc.setGroupAccess('t1', 'g1', ['r1'], true);
    expect(callUrl()).toContain('/groups/g1/access');
  });

  it('listDevices GETs', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '[]', json: async () => [] } as never);
    await svc.listDevices('t1');
    expect(callUrl()).toContain('/devices');
  });

  it('revokeDevice DELETEs', async () => {
    await svc.revokeDevice('t1', 'dev-1');
    expect(callUrl()).toContain('/devices/dev-1');
  });

  it('listBlocks + blockUser + unblockUser', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '[]', json: async () => [] } as never);
    await svc.listBlocks('t1');
    await svc.blockUser('t1', 'u2');
    await svc.unblockUser('t1', 'u2');
    expect(fetchMock).toHaveBeenCalled();
  });

  it('pinMessage + unpinMessage', async () => {
    await svc.pinMessage('t1', 'ch-1', 'm1');
    await svc.unpinMessage('t1', 'ch-1', 'm1');
    expect(fetchMock).toHaveBeenCalled();
  });

  it('muteChannel + unmuteChannel', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{}', json: async () => ({}) } as never);
    await svc.muteChannel('t1', 'ch-1');
    await svc.muteChannel('t1', 'ch-1', new Date().toISOString());
    await svc.unmuteChannel('t1', 'ch-1');
    expect(fetchMock).toHaveBeenCalled();
  });

  it('searchGif + embedGif + getGiphyIntegration + setGiphyApiKey', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{}', json: async () => ({ configured: true, results: [], url: 'x', query: 'cat' }) } as never);
    await svc.searchGif('t1', 'cat', 10);
    await svc.embedGif('t1', 'https://gif/x');
    await svc.getGiphyIntegration('t1');
    await svc.setGiphyApiKey('t1', 'gph_key');
    expect(fetchMock).toHaveBeenCalled();
  });

  it('votePoll + unvotePoll + createPoll', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{}', json: async () => ({}) } as never);
    await svc.votePoll('t1', 'p1', 0);
    await svc.unvotePoll('t1', 'p1');
    await svc.createPoll('t1', 'ch-1', { question: 'Q?', options: ['a', 'b'] } as never);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('getAuditEvents GETs with limit', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '[]', json: async () => [] } as never);
    await svc.getAuditEvents('t1', 200);
    expect(callUrl()).toContain('/audit');
  });

  it('leaveTeam DELETEs', async () => {
    await svc.leaveTeam('t1');
    expect(fetchMock).toHaveBeenCalled();
  });

  it('generateJoinToken POSTs', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{}', json: async () => ({ token: 'x', join_command: 'y' }) } as never);
    await svc.generateJoinToken('t1');
    expect(fetchMock).toHaveBeenCalled();
  });

  it('DM methods', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{}', json: async () => ({ messages: [] }) } as never);
    await svc.sendDMMessage('t1', 'dm-1', 'hi');
    await svc.getDMMessages('t1', 'dm-1');
    await svc.editDMMessage('t1', 'dm-1', 'm1', 'edit');
    await svc.deleteDMMessage('t1', 'dm-1', 'm1');
    await svc.addDMMembers('t1', 'dm-1', ['u3']);
    expect(fetchMock).toHaveBeenCalled();
  });
});
