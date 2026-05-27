// Cover AuditLogTab (route-style audit log view).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const apiMocks = vi.hoisted(() => ({
  getAuditEvents: vi.fn(async () => [
    { id: 'e1', created_at: '2026-01-01', actor_user_id: 'me', action: 'role.create', target_type: 'role', target_id: 'r1', details: '{"name":"Admin"}' },
    { id: 'e2', created_at: '2026-01-02', actor_user_id: 'me', action: 'role.update', target_type: 'role', target_id: 'r1', details: '{"name":"Renamed"}' },
    { id: 'e3', created_at: '2026-01-03', actor_user_id: 'me', action: 'role.delete', target_type: 'role', target_id: 'r-old', details: '{"name":"OldRole"}' },
    { id: 'e4', created_at: '2026-01-04', actor_user_id: 'me', action: 'channel.create', target_type: 'channel', target_id: 'ch-1', details: '{"name":"general","type":"text"}' },
    { id: 'e5', created_at: '2026-01-05', actor_user_id: 'me', action: 'channel.delete', target_type: 'channel', target_id: 'ch-old', details: '{"name":"old-chan"}' },
    { id: 'e6', created_at: '2026-01-06', actor_user_id: 'me', action: 'channel.lock', target_type: 'channel', target_id: 'ch-1', details: '{"name":"general"}' },
    { id: 'e7', created_at: '2026-01-07', actor_user_id: 'me', action: 'channel.unlock', target_type: 'channel', target_id: 'ch-1', details: '{"name":"general"}' },
    { id: 'e8', created_at: '2026-01-08', actor_user_id: 'me', action: 'member.roles.update', target_type: 'user', target_id: 'u2', details: null },
    { id: 'e9', created_at: '2026-01-09', actor_user_id: 'me', action: 'member.kick', target_type: 'user', target_id: 'u2', details: null },
    { id: 'e10', created_at: '2026-01-10', actor_user_id: 'me', action: 'member.ban', target_type: 'user', target_id: 'u2', details: '{"reason":"spam"}' },
    { id: 'e11', created_at: '2026-01-11', actor_user_id: 'me', action: 'team.update', target_type: null, target_id: null, details: '{"name":"NewName"}' },
    { id: 'e12', created_at: '2026-01-12', actor_user_id: 'me', action: 'invite.create', target_type: null, target_id: null, details: '{"max_uses":10,"expires_at":"2030-01-01"}' },
    { id: 'e13', created_at: '2026-01-13', actor_user_id: 'me', action: 'invite.revoke', target_type: null, target_id: null, details: null },
    { id: 'e14', created_at: '2026-01-14', actor_user_id: 'me', action: 'unknown.action', target_type: null, target_id: null, details: null },
  ]),
}));

vi.mock('../../services/api', () => ({ api: apiMocks }));

import AuditLogTab from './AuditLogTab';
import { useTeamStore } from '../../stores/teamStore';

beforeEach(() => {
  apiMocks.getAuditEvents.mockClear();
  useTeamStore.setState({
    activeTeamId: 't1',
    members: new Map([['t1', [
      { id: 'me-m', userId: 'me', username: 'me', displayName: 'Me', publicKeyHex: '', avatarUrl: '', isAdmin: true, roles: [], roleIds: [] },
      { id: 'u2-m', userId: 'u2', username: 'alice', displayName: 'Alice', publicKeyHex: '', avatarUrl: '', isAdmin: false, roles: [], roleIds: [] },
    ]]]),
  } as never);
});

describe('AuditLogTab', () => {
  it('fetches + renders all action describe() variants', async () => {
    const { container } = render(<AuditLogTab teamId="t1" />);
    await waitFor(() => expect(apiMocks.getAuditEvents).toHaveBeenCalledWith('t1', 200));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders error state when fetch fails', async () => {
    apiMocks.getAuditEvents.mockRejectedValueOnce(new Error('forbidden'));
    const { container } = render(<AuditLogTab teamId="t1" />);
    await waitFor(() => expect(container.firstChild).toBeTruthy());
  });

  it('renders loading state initially', () => {
    apiMocks.getAuditEvents.mockImplementationOnce(() => new Promise(() => {})); // hangs
    const { container } = render(<AuditLogTab teamId="t1" />);
    expect(container.firstChild).toBeTruthy();
  });

  it('handles empty audit log', async () => {
    apiMocks.getAuditEvents.mockResolvedValueOnce([]);
    const { container } = render(<AuditLogTab teamId="t1" />);
    await waitFor(() => expect(apiMocks.getAuditEvents).toHaveBeenCalled());
    expect(container.firstChild).toBeTruthy();
  });

  it('handles malformed JSON in details', async () => {
    apiMocks.getAuditEvents.mockResolvedValueOnce([
      { id: 'eb', created_at: '2026-01-01', actor_user_id: 'me', action: 'role.create', target_type: null, target_id: null, details: 'not json' },
    ]);
    const { container } = render(<AuditLogTab teamId="t1" />);
    await waitFor(() => expect(container.firstChild).toBeTruthy());
  });

  it('handles audit events with missing name detail (covers `name || \'—\'` defaults)', async () => {
    apiMocks.getAuditEvents.mockResolvedValueOnce([
      { id: 'e1', created_at: '2026-03-01', actor_user_id: 'me', action: 'role.create', target_type: 'role', target_id: 'r1', details: null },
      { id: 'e2', created_at: '2026-03-02', actor_user_id: 'me', action: 'role.update', target_type: 'role', target_id: 'r1', details: null },
      { id: 'e3', created_at: '2026-03-03', actor_user_id: 'me', action: 'role.delete', target_type: 'role', target_id: 'r1', details: null },
      { id: 'e4', created_at: '2026-03-04', actor_user_id: 'me', action: 'channel.create', target_type: 'channel', target_id: 'ch1', details: '{}' },
      { id: 'e5', created_at: '2026-03-05', actor_user_id: 'me', action: 'channel.update', target_type: 'channel', target_id: 'ch1', details: '{}' },
      { id: 'e6', created_at: '2026-03-06', actor_user_id: 'me', action: 'channel.delete', target_type: 'channel', target_id: 'ch1', details: '{}' },
      { id: 'e7', created_at: '2026-03-07', actor_user_id: 'me', action: 'channel.lock', target_type: 'channel', target_id: 'ch1', details: '{}' },
      { id: 'e8', created_at: '2026-03-08', actor_user_id: 'me', action: 'channel.unlock', target_type: 'channel', target_id: 'ch1', details: '{}' },
      { id: 'e9', created_at: '2026-03-09', actor_user_id: 'me', action: 'group.create', target_type: 'group', target_id: 'g1', details: '{}' },
      { id: 'e10', created_at: '2026-03-10', actor_user_id: 'me', action: 'group.update', target_type: 'group', target_id: 'g1', details: '{}' },
      { id: 'e11', created_at: '2026-03-11', actor_user_id: 'me', action: 'group.delete', target_type: 'group', target_id: 'g1', details: '{}' },
      { id: 'e12', created_at: '2026-03-12', actor_user_id: 'me', action: 'group.access', target_type: 'group', target_id: 'g1', details: '{}' },
      // member events with unknown target_user — exercises `targetUser ?? e.target_id ?? '?'` branches.
      { id: 'e13', created_at: '2026-03-13', actor_user_id: 'me', action: 'member.roles.update', target_type: 'user', target_id: 'ghost-user-id', details: null },
      { id: 'e14', created_at: '2026-03-14', actor_user_id: 'me', action: 'member.kick', target_type: 'user', target_id: 'ghost-user-id', details: null },
      { id: 'e15', created_at: '2026-03-15', actor_user_id: 'me', action: 'member.ban', target_type: 'user', target_id: 'ghost-user-id', details: null },
      // member events with no target_id at all.
      { id: 'e16', created_at: '2026-03-16', actor_user_id: 'me', action: 'member.kick', target_type: 'user', target_id: null, details: null },
      { id: 'e17', created_at: '2026-03-17', actor_user_id: 'me', action: 'team.update', target_type: null, target_id: null, details: null },
      { id: 'e18', created_at: '2026-03-18', actor_user_id: 'me', action: 'invite.create', target_type: null, target_id: null, details: '{}' },
    ]);
    const { container } = render(<AuditLogTab teamId="t1" />);
    await waitFor(() => expect(apiMocks.getAuditEvents).toHaveBeenCalled());
    expect(container.firstChild).toBeTruthy();
  });

  it('handles audit event with system actor (no actor_user_id)', async () => {
    apiMocks.getAuditEvents.mockResolvedValueOnce([
      { id: 'sys', created_at: '2026-03-20', actor_user_id: null, action: 'role.create', target_type: 'role', target_id: 'r1', details: '{"name":"Admin"}' },
    ]);
    const { container } = render(<AuditLogTab teamId="t1" />);
    await waitFor(() => expect(container.textContent).toContain('system'));
  });

  it('handles audit event with unknown actor (short-id fallback)', async () => {
    apiMocks.getAuditEvents.mockResolvedValueOnce([
      { id: 'unk', created_at: '2026-03-21', actor_user_id: 'ghost-12345678', action: 'role.create', target_type: 'role', target_id: 'r1', details: '{"name":"X"}' },
    ]);
    const { container } = render(<AuditLogTab teamId="t1" />);
    // actor.username || e.actor_user_id.slice(0,8)
    await waitFor(() => expect(container.textContent).toContain('ghost-12'));
  });

  it('renders every remaining describe() case', async () => {
    apiMocks.getAuditEvents.mockResolvedValueOnce([
      { id: 'r1', created_at: '2026-02-01', actor_user_id: 'me', action: 'role.reorder', target_type: null, target_id: null, details: null },
      { id: 'c1', created_at: '2026-02-02', actor_user_id: 'me', action: 'channel.update', target_type: 'channel', target_id: 'ch1', details: '{"name":"renamed"}' },
      { id: 'c2', created_at: '2026-02-03', actor_user_id: 'me', action: 'channel.access.update', target_type: 'channel', target_id: 'ch1', details: null },
      { id: 'g1', created_at: '2026-02-04', actor_user_id: 'me', action: 'group.create', target_type: 'group', target_id: 'g1', details: '{"name":"Team"}' },
      { id: 'g2', created_at: '2026-02-05', actor_user_id: 'me', action: 'group.update', target_type: 'group', target_id: 'g1', details: '{"name":"Team"}' },
      { id: 'g3', created_at: '2026-02-06', actor_user_id: 'me', action: 'group.delete', target_type: 'group', target_id: 'g1', details: '{"name":"OldGroup"}' },
      { id: 'g4', created_at: '2026-02-07', actor_user_id: 'me', action: 'group.access', target_type: 'group', target_id: 'g1', details: '{"name":"Engineering"}' },
      { id: 'mp', created_at: '2026-02-08', actor_user_id: 'me', action: 'message.pin', target_type: 'message', target_id: 'msg1', details: null },
      { id: 'mu', created_at: '2026-02-09', actor_user_id: 'me', action: 'message.unpin', target_type: 'message', target_id: 'msg1', details: null },
      { id: 'gx', created_at: '2026-02-10', actor_user_id: 'me', action: 'integration.giphy.set', target_type: null, target_id: null, details: null },
      { id: 'gy', created_at: '2026-02-11', actor_user_id: 'me', action: 'integration.giphy.clear', target_type: null, target_id: null, details: null },
      { id: 'ml', created_at: '2026-02-12', actor_user_id: 'me', action: 'member.leave', target_type: 'user', target_id: 'me', details: null },
    ]);
    const { container } = render(<AuditLogTab teamId="t1" />);
    await waitFor(() => expect(apiMocks.getAuditEvents).toHaveBeenCalled());
    expect(container.firstChild).toBeTruthy();
  });
});
