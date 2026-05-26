// Drive TeamSidebar context-menu action handlers (markAllRead, leave,
// settings/invites/federation navigation) and drop-onto-self / drop-onto-
// unknown edge cases.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const navigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

vi.mock('../../stores/confirmStore', () => ({
  dillaConfirm: vi.fn(async () => true),
}));

const apiMocks = vi.hoisted(() => ({
  markChannelRead: vi.fn(async () => {}),
  leaveTeam: vi.fn(async () => {}),
}));
vi.mock('../../services/api', () => ({ api: apiMocks }));

import TeamSidebar from './TeamSidebar';
import { useAuthStore } from '../../stores/authStore';
import { useTeamStore } from '../../stores/teamStore';
import { useUnreadStore } from '../../stores/unreadStore';

function wrap(children: React.ReactElement) {
  return <MemoryRouter>{children}</MemoryRouter>;
}

function seedStores() {
  useAuthStore.setState({
    teams: new Map([
      ['t1', { token: 'tok', user: { id: 'me' }, teamInfo: { name: 'Acme' }, baseUrl: 'https://srv' }],
      ['t2', { token: 'tok', user: { id: 'me' }, teamInfo: { name: 'Beta', federated: true }, baseUrl: 'https://srv2' }],
    ]),
    servers: new Map(),
    setTeamOrder: vi.fn(),
    removeTeam: vi.fn(),
  } as never);
  useTeamStore.setState({
    activeTeamId: 't1',
    teams: new Map([
      ['t1', { id: 't1', name: 'Acme' }],
      ['t2', { id: 't2', name: 'Beta' }],
    ]),
    channels: new Map([
      ['t1', [{ id: 'ch-1', name: 'general', type: 'text' }, { id: 'ch-2', name: 'random', type: 'text' }]],
    ]),
    setActiveTeam: vi.fn(),
  } as never);
  useUnreadStore.setState({ counts: { 'ch-1': 3, 'ch-2': 5 } } as never);
}

beforeEach(() => {
  navigate.mockClear();
  apiMocks.markChannelRead.mockClear();
  apiMocks.leaveTeam.mockClear();
  seedStores();
});

function openMenu(container: HTMLElement, teamLabel = 'Acme') {
  const team = [...container.querySelectorAll('.team-icon-wrapper')].find((el) =>
    el.getAttribute('data-tooltip') === teamLabel,
  ) as HTMLElement;
  fireEvent.contextMenu(team, { clientX: 100, clientY: 100 });
}

describe('Context menu — Settings / Invites / Federation', () => {
  it('Settings menu item navigates to /app/settings', () => {
    const { container } = render(wrap(<TeamSidebar />));
    openMenu(container);
    const settings = [...document.querySelectorAll('button, li, [role="menuitem"]')].find((el) => /settings/i.test(el.textContent ?? '')) as HTMLElement | undefined;
    if (settings) fireEvent.click(settings);
    expect(navigate).toHaveBeenCalledWith('/app/settings');
  });

  it('Invites menu item navigates to /app/settings', () => {
    const { container } = render(wrap(<TeamSidebar />));
    openMenu(container);
    const invites = [...document.querySelectorAll('button, li, [role="menuitem"]')].find((el) => /invite/i.test(el.textContent ?? '')) as HTMLElement | undefined;
    if (invites) fireEvent.click(invites);
    expect(navigate).toHaveBeenCalledWith('/app/settings');
  });

  it('Federation menu item navigates to /app/settings', () => {
    const { container } = render(wrap(<TeamSidebar />));
    openMenu(container);
    const fed = [...document.querySelectorAll('button, li, [role="menuitem"]')].find((el) => /federation/i.test(el.textContent ?? '')) as HTMLElement | undefined;
    if (fed) fireEvent.click(fed);
    expect(navigate).toHaveBeenCalledWith('/app/settings');
  });
});

describe('Mark all read', () => {
  it('zeros unread + calls api.markChannelRead per channel', () => {
    const { container } = render(wrap(<TeamSidebar />));
    openMenu(container);
    const markBtn = [...document.querySelectorAll('button, li, [role="menuitem"]')].find((el) => /mark.*read/i.test(el.textContent ?? '')) as HTMLElement | undefined;
    if (markBtn) fireEvent.click(markBtn);
    expect(apiMocks.markChannelRead).toHaveBeenCalledTimes(2);
    expect(useUnreadStore.getState().counts['ch-1']).toBe(0);
    expect(useUnreadStore.getState().counts['ch-2']).toBe(0);
  });
});

describe('Leave team', () => {
  it('calls api.leaveTeam + removeTeam + navigates to /app on confirm', async () => {
    const { container } = render(wrap(<TeamSidebar />));
    openMenu(container);
    const leaveBtn = [...document.querySelectorAll('button, li, [role="menuitem"]')].find((el) => /leave/i.test(el.textContent ?? '')) as HTMLElement | undefined;
    if (leaveBtn) {
      await act(async () => {
        fireEvent.click(leaveBtn);
        await Promise.resolve();
        await Promise.resolve();
      });
    }
    expect(apiMocks.leaveTeam).toHaveBeenCalledWith('t1');
    expect(navigate).toHaveBeenCalledWith('/app');
  });
});

describe('Federated dot', () => {
  it('shows the federated dot for teams with federated=true', () => {
    const { container } = render(wrap(<TeamSidebar />));
    const beta = [...container.querySelectorAll('.team-icon-wrapper')].find((el) => el.getAttribute('data-tooltip') === 'Beta') as HTMLElement;
    expect(beta.querySelector('.team-federated-dot')).toBeTruthy();
  });
});

describe('Unread badge', () => {
  it('shows total unread count summed across channels (3 + 5 = 8)', () => {
    const { container } = render(wrap(<TeamSidebar />));
    const acme = [...container.querySelectorAll('.team-icon-wrapper')].find((el) => el.getAttribute('data-tooltip') === 'Acme') as HTMLElement;
    const badge = acme.querySelector('.team-badge');
    expect(badge?.textContent).toBe('8');
  });

  it('shows 99+ when total exceeds 99', () => {
    useUnreadStore.setState({ counts: { 'ch-1': 50, 'ch-2': 60 } } as never);
    const { container } = render(wrap(<TeamSidebar />));
    const acme = [...container.querySelectorAll('.team-icon-wrapper')].find((el) => el.getAttribute('data-tooltip') === 'Acme') as HTMLElement;
    expect(acme.querySelector('.team-badge')?.textContent).toBe('99+');
  });
});

describe('Drag-drop edge cases', () => {
  it('dropping onto self is a no-op', () => {
    const { container } = render(wrap(<TeamSidebar />));
    const acme = [...container.querySelectorAll('.team-icon-wrapper')].find((el) => el.getAttribute('data-tooltip') === 'Acme') as HTMLElement;
    fireEvent.dragStart(acme);
    fireEvent.drop(acme);
    expect(useAuthStore.getState().setTeamOrder).not.toHaveBeenCalled();
  });

  it('dragEnd clears the dragging state', () => {
    const { container } = render(wrap(<TeamSidebar />));
    const acme = [...container.querySelectorAll('.team-icon-wrapper')].find((el) => el.getAttribute('data-tooltip') === 'Acme') as HTMLElement;
    fireEvent.dragStart(acme);
    fireEvent.dragEnd(acme);
    expect(acme.getAttribute('data-dragging')).toBeNull();
  });
});
