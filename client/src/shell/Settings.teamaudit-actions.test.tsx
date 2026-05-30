// Hit every case in the TeamAudit `describe(e)` switch so each action label
// is exercised. Lines L2485-L2510 in Settings.tsx.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({
  api: { getAuditEvents: vi.fn(async () => []) },
}));
vi.mock('../services/api', () => apiMock);

vi.mock('../stores/authStore', async () => {
  const actual = await vi.importActual<typeof import('../stores/authStore')>('../stores/authStore');
  return {
    ...actual,
    useAuthStore: Object.assign((sel: (s: unknown) => unknown) => sel({
      teams: new Map([['t1', { baseUrl: 'https://x', token: 'tok' }]]),
    }), {
      getState: () => ({
        teams: new Map([['t1', { baseUrl: 'https://x', token: 'tok' }]]),
        derivedKey: 'k',
      }),
      setState: vi.fn(),
    }),
  };
});

vi.mock('../stores/teamStore', () => ({
  useTeamStore: Object.assign((sel: (s: unknown) => unknown) => sel({
    activeTeamId: 't1',
    members: new Map([['t1', [
      { userId: 'u-actor', username: 'admin' },
      { userId: 'u-target', username: 'targetUser' },
    ]]]),
  }), {
    getState: () => ({
      activeTeamId: 't1',
      members: new Map([['t1', [
        { userId: 'u-actor', username: 'admin' },
        { userId: 'u-target', username: 'targetUser' },
      ]]]),
    }),
    setState: vi.fn(),
  }),
}));

import { TeamAudit } from './Settings';

beforeEach(() => {
  apiMock.api.getAuditEvents.mockReset();
});

const ALL_ACTIONS: { action: string; details?: string; target?: string }[] = [
  { action: 'role.create', details: JSON.stringify({ name: 'mods' }) },
  { action: 'role.update', details: JSON.stringify({ name: 'mods' }) },
  { action: 'role.delete', details: JSON.stringify({ name: 'mods' }) },
  { action: 'role.reorder' },
  { action: 'channel.create', details: JSON.stringify({ name: 'general', type: 'text' }) },
  { action: 'channel.delete', details: JSON.stringify({ name: 'general' }) },
  { action: 'channel.lock', details: JSON.stringify({ name: 'general' }) },
  { action: 'channel.unlock', details: JSON.stringify({ name: 'general' }) },
  { action: 'channel.update', details: JSON.stringify({ name: 'general' }) },
  { action: 'channel.access.update' },
  { action: 'member.roles.update', target: 'u-target' },
  { action: 'member.kick', target: 'u-target' },
  { action: 'member.ban', target: 'u-target', details: JSON.stringify({ reason: 'spam' }) },
  { action: 'team.update', details: JSON.stringify({ name: 'New name' }) },
  { action: 'invite.create', details: JSON.stringify({ max_uses: 5, expires_at: '2030-01-01' }) },
  { action: 'invite.revoke' },
  { action: 'unknown.action.passthrough' },
];

describe('TeamAudit describe() switch coverage', () => {
  it('renders a row for every audit action variant', async () => {
    apiMock.api.getAuditEvents.mockResolvedValueOnce(
      ALL_ACTIONS.map((e, i) => ({
        id: `ae-${i}`,
        created_at: '2026-05-26T10:00:00Z',
        actor_user_id: 'u-actor',
        action: e.action,
        target_type: e.target ? 'user' : null,
        target_id: e.target ?? null,
        details: e.details ?? null,
      })),
    );
    let renderResult!: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<TeamAudit />);
    });
    await waitFor(() => {
      expect(renderResult.container.querySelectorAll('[style*="grid-template-columns"]').length).toBeGreaterThanOrEqual(ALL_ACTIONS.length - 1);
    });
  });

  it('renders the error banner when getAuditEvents rejects', async () => {
    apiMock.api.getAuditEvents.mockRejectedValueOnce(new Error('api fail'));
    let renderResult!: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<TeamAudit />);
    });
    await waitFor(() => expect(renderResult.container.textContent).toContain('api fail'));
  });

  it('renders empty state when no events', async () => {
    apiMock.api.getAuditEvents.mockResolvedValueOnce([]);
    let renderResult!: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<TeamAudit />);
    });
    await waitFor(() => expect(renderResult.container.textContent).toContain('No audit events yet'));
  });

  it('handles malformed details JSON without crashing', async () => {
    apiMock.api.getAuditEvents.mockResolvedValueOnce([
      { id: 'm-bad', created_at: '2026-01-01', actor_user_id: 'u-actor', action: 'team.update', details: '{not json' },
    ]);
    let renderResult!: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<TeamAudit />);
    });
    await waitFor(() => expect(renderResult.container.textContent).toContain('updated team settings'));
  });
});
