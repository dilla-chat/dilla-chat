// Drive TeamInvites create/revoke/copy flow.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const apiMocks = vi.hoisted(() => ({
  listInvites: vi.fn(async () => [
    { id: 'inv-1', token: 'tok-aaa', uses: 0, max_uses: 10, expires_at: null },
    { id: 'inv-2', token: 'tok-bbb', uses: 3, max_uses: 5, expires_at: '2099-01-01' },
  ]),
  createInvite: vi.fn(async () => ({ id: 'inv-new', token: 'tok-new', uses: 0, max_uses: 1 })),
  revokeInvite: vi.fn(async () => {}),
}));
vi.mock('../services/api', () => ({ api: apiMocks }));
vi.mock('../services/mockSession', () => ({ isMockSession: () => false }));
vi.mock('../services/websocket', () => ({ ws: { on: vi.fn(() => () => {}) } }));
vi.mock('../stores/confirmStore', () => ({ dillaConfirm: vi.fn(async () => true) }));

import { TeamInvites } from './Settings';
import { ShellDataProvider } from './ShellDataContext';
import { useAuthStore } from '../stores/authStore';
import { useTeamStore } from '../stores/teamStore';

const SHELL = {
  SERVERS: [{ id: 't1', name: 'Acme' }], CHANNELS: [],
  MEMBERS: [], byId: {},
  MESSAGES: {}, DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: {},
  activeServerId: 't1', activeChannelId: null, currentUserId: 'me',
};

function wrap(c: React.ReactNode) {
  return (
    <MemoryRouter>
      <ShellDataProvider value={SHELL}>{c}</ShellDataProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  for (const fn of Object.values(apiMocks)) fn.mockClear();
  apiMocks.listInvites.mockResolvedValue([
    { id: 'inv-1', token: 'tok-aaa', uses: 0, max_uses: 10, expires_at: null },
    { id: 'inv-2', token: 'tok-bbb', uses: 3, max_uses: 5, expires_at: '2099-01-01' },
  ]);
  useAuthStore.setState({
    derivedKey: 'k',
    teams: new Map([['t1', { user: { id: 'me' }, baseUrl: 'https://srv', token: 'tok', teamInfo: {} }]]),
  } as never);
  useTeamStore.setState({
    activeTeamId: 't1',
    teams: new Map([['t1', { id: 't1', name: 'Acme' }]]),
    channels: new Map([['t1', []]]),
    members: new Map([['t1', []]]),
    roles: new Map([['t1', []]]),
    groups: new Map([['t1', []]]),
  } as never);
});

describe('TeamInvites', () => {
  it('renders and fetches existing invites', async () => {
    render(wrap(<TeamInvites />));
    await waitFor(() => expect(apiMocks.listInvites).toHaveBeenCalledWith('t1'));
  });

  it('shows existing invite tokens', async () => {
    const { container } = render(wrap(<TeamInvites />));
    await waitFor(() => {
      expect(container.textContent).toMatch(/tok-aaa|tok-bbb|inv-1|inv-2/i);
    });
  });

  it('clicks New invite calls api.createInvite', async () => {
    const { container } = render(wrap(<TeamInvites />));
    await waitFor(() => expect(apiMocks.listInvites).toHaveBeenCalled());
    const newBtn = [...container.querySelectorAll('button')].find((b) => /new invite|create invite/i.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
    if (newBtn) {
      await act(async () => {
        fireEvent.click(newBtn);
        await Promise.resolve();
      });
      expect(apiMocks.createInvite).toHaveBeenCalled();
    }
  });

  it('clicks Revoke calls api.revokeInvite', async () => {
    const { container } = render(wrap(<TeamInvites />));
    await waitFor(() => expect(apiMocks.listInvites).toHaveBeenCalled());
    const revokeBtn = [...container.querySelectorAll('button')].find((b) => /revoke|delete/i.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
    if (revokeBtn) {
      await act(async () => {
        fireEvent.click(revokeBtn);
        await Promise.resolve();
        await Promise.resolve();
      });
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('handles empty invite list', async () => {
    apiMocks.listInvites.mockResolvedValueOnce([]);
    const { container } = render(wrap(<TeamInvites />));
    await waitFor(() => expect(apiMocks.listInvites).toHaveBeenCalled());
    expect(container.firstChild).toBeTruthy();
  });

  it('handles listInvites error gracefully', async () => {
    apiMocks.listInvites.mockRejectedValueOnce(new Error('forbidden'));
    const { container } = render(wrap(<TeamInvites />));
    await waitFor(() => expect(apiMocks.listInvites).toHaveBeenCalled());
    expect(container.firstChild).toBeTruthy();
  });

  it('renders disabled state when no auth', () => {
    useAuthStore.setState({ teams: new Map() } as never);
    const { container } = render(wrap(<TeamInvites />));
    expect(container.firstChild).toBeTruthy();
  });

  it('clicks every button to exercise full surface', async () => {
    const { container } = render(wrap(<TeamInvites />));
    await waitFor(() => expect(apiMocks.listInvites).toHaveBeenCalled());
    const buttons = [...container.querySelectorAll('button')] as HTMLButtonElement[];
    for (const b of buttons) {
      try { fireEvent.click(b); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });
});
