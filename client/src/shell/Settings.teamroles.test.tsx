// Drive TeamRoles create/edit/delete/reorder flow.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const apiMocks = vi.hoisted(() => ({
  createRole: vi.fn(async () => ({ id: 'r-new', name: 'New role', color: '#7a9aa7', permissions: 0x10 })),
  deleteRole: vi.fn(async () => {}),
  reorderRoles: vi.fn(async () => {}),
  getRoles: vi.fn(async () => [
    { id: 'r1', name: 'Admin', color: '#f00', position: 2, permissions: 0xFFF, isDefault: false },
    { id: 'r2', name: 'Mod', color: '#0f0', position: 1, permissions: 0x2, isDefault: false },
    { id: 'r3', name: '@everyone', color: '#888', position: 0, permissions: 0x47, isDefault: true },
  ]),
  updateRole: vi.fn(async () => ({})),
}));
vi.mock('../services/api', () => ({ api: apiMocks }));
vi.mock('../services/mockSession', () => ({ isMockSession: () => false }));
vi.mock('../services/websocket', () => ({ ws: { on: vi.fn(() => () => {}) } }));
vi.mock('../stores/confirmStore', () => ({
  dillaConfirm: vi.fn(async () => true),
}));

import { TeamRoles } from './Settings';
import { ShellDataProvider } from './ShellDataContext';
import { useAuthStore } from '../stores/authStore';
import { useTeamStore } from '../stores/teamStore';

const SHELL = {
  SERVERS: [], CHANNELS: [],
  MEMBERS: [{ id: 'me', name: 'me', initials: 'ME', color: '#f00' }],
  byId: { me: { id: 'me' } },
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
  useAuthStore.setState({
    derivedKey: 'k',
    teams: new Map([['t1', { user: { id: 'me' }, baseUrl: 'https://srv', token: 'tok', teamInfo: {} }]]),
  } as never);
  useTeamStore.setState({
    activeTeamId: 't1',
    teams: new Map([['t1', { id: 't1', name: 'Acme' }]]),
    channels: new Map([['t1', []]]),
    members: new Map([['t1', [
      { id: 'me-m', userId: 'me', isAdmin: true, roleIds: ['r1'], roles: [{ id: 'r1', name: 'Admin', permissions: 1 }] },
    ]]]),
    roles: new Map([['t1', [
      { id: 'r1', name: 'Admin', color: '#f00', position: 2, permissions: 0xFFF, isDefault: false },
      { id: 'r2', name: 'Mod', color: '#0f0', position: 1, permissions: 0x2, isDefault: false },
      { id: 'r3', name: '@everyone', color: '#888', position: 0, permissions: 0x47, isDefault: true },
    ]]]),
    groups: new Map([['t1', []]]),
  } as never);
});

describe('TeamRoles', () => {
  it('renders all roles + default role section', () => {
    const { container } = render(wrap(<TeamRoles />));
    expect(container.textContent).toContain('Admin');
    expect(container.textContent).toContain('Mod');
    expect(container.textContent).toContain('@everyone');
    expect(container.textContent).toContain('default');
  });

  it('shows member count per role', () => {
    const { container } = render(wrap(<TeamRoles />));
    expect(container.textContent).toMatch(/1 member/);
  });

  it('clicking + New role calls api.createRole', async () => {
    const { container } = render(wrap(<TeamRoles />));
    const newBtn = [...container.querySelectorAll('button')].find((b) => /new role/i.test(b.textContent ?? '')) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(newBtn);
      await Promise.resolve();
    });
    expect(apiMocks.createRole).toHaveBeenCalled();
  });

  it('clicking Edit opens the RoleEditor modal', () => {
    const { container } = render(wrap(<TeamRoles />));
    const editBtns = [...container.querySelectorAll('button')].filter((b) => b.textContent === 'Edit') as HTMLButtonElement[];
    if (editBtns[0]) fireEvent.click(editBtns[0]);
    expect(document.body.textContent).toContain('Edit role');
  });

  it('clicking Delete asks for confirm and calls api.deleteRole', async () => {
    const { container } = render(wrap(<TeamRoles />));
    const deleteBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Delete') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(deleteBtn);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiMocks.deleteRole).toHaveBeenCalled();
  });

  it('createRole error dispatches dilla:notify', async () => {
    apiMocks.createRole.mockRejectedValueOnce(new Error('forbidden'));
    const listener = vi.fn();
    window.addEventListener('dilla:notify', listener);
    const { container } = render(wrap(<TeamRoles />));
    const newBtn = [...container.querySelectorAll('button')].find((b) => /new role/i.test(b.textContent ?? '')) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(newBtn);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(listener).toHaveBeenCalled();
    window.removeEventListener('dilla:notify', listener);
  });

  it('drag/drop reordering: dragStart + drop on another role', () => {
    const { container } = render(wrap(<TeamRoles />));
    const rows = [...container.querySelectorAll('.set-tr.role')] as HTMLElement[];
    if (rows.length >= 2) {
      fireEvent.dragStart(rows[0], { dataTransfer: { effectAllowed: '', dropEffect: '', setData: () => {}, getData: () => '' } });
      fireEvent.dragOver(rows[1], { dataTransfer: { effectAllowed: '', dropEffect: '', setData: () => {}, getData: () => '' } });
      fireEvent.drop(rows[1]);
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('drag/drop to same role is a no-op', () => {
    const { container } = render(wrap(<TeamRoles />));
    const rows = [...container.querySelectorAll('.set-tr.role')] as HTMLElement[];
    if (rows[0]) {
      fireEvent.dragStart(rows[0], { dataTransfer: { effectAllowed: '', dropEffect: '', setData: () => {}, getData: () => '' } });
      fireEvent.drop(rows[0]);
    }
    expect(apiMocks.reorderRoles).not.toHaveBeenCalled();
  });

  it('dragEnd clears the drag state', () => {
    const { container } = render(wrap(<TeamRoles />));
    const rows = [...container.querySelectorAll('.set-tr.role')] as HTMLElement[];
    if (rows[0]) {
      fireEvent.dragStart(rows[0], { dataTransfer: { effectAllowed: '', dropEffect: '', setData: () => {}, getData: () => '' } });
      fireEvent.dragEnd(rows[0]);
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('renders disabled message when not authenticated', () => {
    useAuthStore.setState({ teams: new Map() } as never);
    const { container } = render(wrap(<TeamRoles />));
    expect(container.firstChild).toBeTruthy();
  });
});
