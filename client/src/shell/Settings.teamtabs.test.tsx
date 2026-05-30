// Drive TeamIntegrations + TeamFederation + TeamAudit deep flows.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const apiMocks = vi.hoisted(() => ({
  getGiphyIntegration: vi.fn(async () => ({ configured: false })),
  setGiphyApiKey: vi.fn(async () => ({ configured: true })),
  getAuditEvents: vi.fn(async () => [
    { id: 'e1', actor_id: 'me', action: 'channel.create', target_type: 'channel', target_id: 'ch-1', created_at: '2026-01-01T00:00:00Z', details: '{"name":"general"}' },
    { id: 'e2', actor_id: 'u2', action: 'role.delete', target_type: 'role', target_id: 'r-old', created_at: '2026-01-02T00:00:00Z', details: '{"name":"OldRole"}' },
  ]),
}));
vi.mock('../services/api', () => ({ api: apiMocks }));
vi.mock('../services/mockSession', () => ({ isMockSession: () => false }));
vi.mock('../services/websocket', () => ({ ws: { on: vi.fn(() => () => {}) } }));

import { TeamIntegrations, TeamFederation, TeamAudit } from './Settings';
import { ShellDataProvider } from './ShellDataContext';
import { useAuthStore } from '../stores/authStore';
import { useTeamStore } from '../stores/teamStore';

const SHELL = {
  SERVERS: [{ id: 't1', name: 'Acme', node: 'gbg-1', federated: true }],
  CHANNELS: [],
  MEMBERS: [{ id: 'me', name: 'me', initials: 'ME', color: '#f00' }],
  byId: { me: { id: 'me', name: 'me' } },
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
  apiMocks.getGiphyIntegration.mockResolvedValue({ configured: false });
  useAuthStore.setState({
    derivedKey: 'k',
    teams: new Map([['t1', { user: { id: 'me' }, baseUrl: 'https://srv', token: 'tok', teamInfo: {} }]]),
  } as never);
  useTeamStore.setState({
    activeTeamId: 't1',
    teams: new Map([['t1', { id: 't1', name: 'Acme' }]]),
    channels: new Map([['t1', []]]),
    members: new Map([['t1', [{ id: 'm1', userId: 'me', username: 'me', displayName: 'Me' }]]]),
    roles: new Map([['t1', []]]),
    groups: new Map([['t1', []]]),
  } as never);
});

describe('TeamIntegrations', () => {
  it('renders + fetches giphy config', async () => {
    render(wrap(<TeamIntegrations />));
    await waitFor(() => expect(apiMocks.getGiphyIntegration).toHaveBeenCalled());
  });

  it('typing in key field updates the input', () => {
    const { container } = render(wrap(<TeamIntegrations />));
    const input = container.querySelector('input.set-input.mono') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'gph_test_key' } });
    expect(input.value).toBe('gph_test_key');
  });

  it('clicking Save fires api.setGiphyApiKey + shows OK message', async () => {
    const { container } = render(wrap(<TeamIntegrations />));
    await waitFor(() => expect(apiMocks.getGiphyIntegration).toHaveBeenCalled());
    const input = container.querySelector('input.set-input.mono') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'key' } });
    const saveBtn = [...container.querySelectorAll('button')].find((b) => /save/i.test(b.textContent ?? '')) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(saveBtn);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiMocks.setGiphyApiKey).toHaveBeenCalledWith('t1', 'key');
    expect(container.textContent).toContain('Saved');
  });

  it('shows Clear key when configured + clicking calls setGiphyApiKey with empty', async () => {
    apiMocks.getGiphyIntegration.mockResolvedValueOnce({ configured: true });
    const { container } = render(wrap(<TeamIntegrations />));
    await waitFor(() => expect(container.textContent).toContain('Clear key'));
    const clearBtn = [...container.querySelectorAll('button')].find((b) => /clear/i.test(b.textContent ?? '')) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(clearBtn);
      await Promise.resolve();
    });
    expect(apiMocks.setGiphyApiKey).toHaveBeenCalledWith('t1', '');
  });

  it('Save error shows error message', async () => {
    apiMocks.setGiphyApiKey.mockRejectedValueOnce(new Error('forbidden'));
    const { container } = render(wrap(<TeamIntegrations />));
    await waitFor(() => expect(apiMocks.getGiphyIntegration).toHaveBeenCalled());
    const input = container.querySelector('input.set-input.mono') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'key' } });
    const saveBtn = [...container.querySelectorAll('button')].find((b) => /save/i.test(b.textContent ?? '')) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(saveBtn);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('forbidden');
  });

  it('renders disabled state when no auth', () => {
    useAuthStore.setState({ teams: new Map() } as never);
    const { container } = render(wrap(<TeamIntegrations />));
    expect(container.firstChild).toBeTruthy();
  });
});

describe('TeamFederation', () => {
  it('renders node info + peers section', () => {
    const { container } = render(wrap(<TeamFederation />));
    expect(container.textContent).toContain('gbg-1');
    expect(container.textContent).toMatch(/federation port|Peers/i);
  });

  it('clicking + Add peer dispatches dilla:add-peer', () => {
    const listener = vi.fn();
    window.addEventListener('dilla:add-peer', listener);
    const { container } = render(wrap(<TeamFederation />));
    const addBtn = [...container.querySelectorAll('button')].find((b) => /add peer/i.test(b.textContent ?? '')) as HTMLButtonElement;
    fireEvent.click(addBtn);
    expect(listener).toHaveBeenCalled();
    window.removeEventListener('dilla:add-peer', listener);
  });

  it('clicking Generate join command also dispatches dilla:add-peer', () => {
    const listener = vi.fn();
    window.addEventListener('dilla:add-peer', listener);
    const { container } = render(wrap(<TeamFederation />));
    const genBtn = [...container.querySelectorAll('button')].find((b) => /generate join/i.test(b.textContent ?? '')) as HTMLButtonElement;
    fireEvent.click(genBtn);
    expect(listener).toHaveBeenCalled();
    window.removeEventListener('dilla:add-peer', listener);
  });

  it('renders "solo" when team is not federated', () => {
    const SHELL2 = { ...SHELL, SERVERS: [{ id: 't1', name: 'Acme', node: 'gbg-1', federated: false }] };
    const { container } = render(
      <MemoryRouter>
        <ShellDataProvider value={SHELL2}>
          <TeamFederation />
        </ShellDataProvider>
      </MemoryRouter>,
    );
    expect(container.textContent).toMatch(/solo|not federated/i);
  });
});

describe('TeamAudit', () => {
  it('renders + fetches audit log', async () => {
    render(wrap(<TeamAudit />));
    await waitFor(() => expect(apiMocks.getAuditEvents).toHaveBeenCalled());
  });

  it('shows audit entries', async () => {
    const { container } = render(wrap(<TeamAudit />));
    await waitFor(() => {
      expect(container.textContent).toMatch(/created channel|deleted role|general|OldRole/i);
    });
  });

  it('handles empty log', async () => {
    apiMocks.getAuditEvents.mockResolvedValueOnce([]);
    const { container } = render(wrap(<TeamAudit />));
    await waitFor(() => expect(apiMocks.getAuditEvents).toHaveBeenCalled());
    expect(container.firstChild).toBeTruthy();
  });

  it('handles getAuditEvents error', async () => {
    apiMocks.getAuditEvents.mockRejectedValueOnce(new Error('forbidden'));
    const { container } = render(wrap(<TeamAudit />));
    await waitFor(() => expect(apiMocks.getAuditEvents).toHaveBeenCalled());
    expect(container.firstChild).toBeTruthy();
  });
});
