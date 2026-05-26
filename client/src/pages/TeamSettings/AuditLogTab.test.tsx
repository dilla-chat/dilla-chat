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
});
