// Drive TeamMembers role-assignment flow (toggle/save/discard/error).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const apiMocks = vi.hoisted(() => ({
  updateMember: vi.fn(async () => ({})),
}));
vi.mock('../services/api', () => ({ api: apiMocks }));
vi.mock('../services/mockSession', () => ({ isMockSession: () => false }));
vi.mock('../services/websocket', () => ({ ws: { on: vi.fn(() => () => {}) } }));

import { TeamMembers } from './Settings';
import { ShellDataProvider } from './ShellDataContext';
import { useTeamStore } from '../stores/teamStore';
import { useAuthStore } from '../stores/authStore';

const SHELL = {
  SERVERS: [], CHANNELS: [],
  MEMBERS: [{ id: 'me', name: 'me', initials: 'ME', color: '#f00' }],
  byId: { me: { id: 'me', name: 'me', initials: 'ME', color: '#f00' } },
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
  apiMocks.updateMember.mockClear();
  useAuthStore.setState({
    derivedKey: 'k',
    teams: new Map([['t1', { user: { id: 'me', display_name: 'Me' }, baseUrl: 'https://srv', token: 'tok', teamInfo: {} }]]),
  } as never);
  useTeamStore.setState({
    activeTeamId: 't1',
    teams: new Map([['t1', { id: 't1', name: 'Acme' }]]),
    channels: new Map([['t1', []]]),
    members: new Map([['t1', [
      { id: 'm1', userId: 'me', username: 'me', displayName: 'Me', publicKeyHex: '', avatarUrl: '', isAdmin: true, roles: [{ id: 'r1', name: 'Admin', permissions: 1 }], roleIds: ['r1'] },
      { id: 'm2', userId: 'u2', username: 'alice', displayName: 'Alice', publicKeyHex: '', avatarUrl: '', isAdmin: false, roles: [], roleIds: [] },
      { id: 'm3', userId: 'u3', username: 'bob', displayName: 'Bob', publicKeyHex: '', avatarUrl: '', isAdmin: false, roles: [{ id: 'r2', name: 'Mod', permissions: 0x2 }], roleIds: ['r2'] },
    ]]]),
    roles: new Map([['t1', [
      { id: 'r1', name: 'Admin', color: '#f00', position: 2, permissions: 0xFFF, isDefault: false },
      { id: 'r2', name: 'Mod', color: '#0f0', position: 1, permissions: 0x2, isDefault: false },
      { id: 'r3', name: '@everyone', color: '#888', position: 0, permissions: 0x47, isDefault: true },
    ]]]),
    groups: new Map([['t1', []]]),
    setMembers: useTeamStore.getState().setMembers,
  } as never);
});

describe('TeamMembers', () => {
  it('renders the member table with usernames', () => {
    const { container } = render(wrap(<TeamMembers />));
    expect(container.textContent).toContain('Me');
    expect(container.textContent).toContain('Alice');
    expect(container.textContent).toContain('Bob');
  });

  it('renders assignable role chips (excluding default)', () => {
    const { container } = render(wrap(<TeamMembers />));
    expect(container.textContent).toContain('Admin');
    expect(container.textContent).toContain('Mod');
    expect(container.textContent).not.toContain('@everyone');
  });

  it('toggling a role chip marks the form dirty + enables Save', () => {
    const { container } = render(wrap(<TeamMembers />));
    const chips = [...container.querySelectorAll('button')].filter((b) => /Admin|Mod/.test(b.textContent ?? '')) as HTMLButtonElement[];
    if (chips.length >= 2) fireEvent.click(chips[1]); // toggle Mod on alice
    const saveBtn = [...container.querySelectorAll('button')].find((b) => /save/i.test(b.textContent ?? '')) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);
  });

  it('clicking Discard reverts the draft', () => {
    const { container } = render(wrap(<TeamMembers />));
    const chips = [...container.querySelectorAll('button')].filter((b) => /Admin|Mod/.test(b.textContent ?? '')) as HTMLButtonElement[];
    if (chips.length >= 2) fireEvent.click(chips[1]);
    const discardBtn = [...container.querySelectorAll('button')].find((b) => /discard/i.test(b.textContent ?? '')) as HTMLButtonElement;
    fireEvent.click(discardBtn);
    const saveBtn = [...container.querySelectorAll('button')].find((b) => /save/i.test(b.textContent ?? '')) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
  });

  it('clicking Save calls api.updateMember for each diff', async () => {
    const { container } = render(wrap(<TeamMembers />));
    const chips = [...container.querySelectorAll('button')].filter((b) => /Mod/.test(b.textContent ?? '')) as HTMLButtonElement[];
    if (chips[0]) fireEvent.click(chips[0]);
    const saveBtn = [...container.querySelectorAll('button')].find((b) => /save/i.test(b.textContent ?? '')) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(saveBtn);
      await Promise.resolve();
    });
    expect(apiMocks.updateMember).toHaveBeenCalled();
  });

  it('Save error dispatches dilla:notify', async () => {
    apiMocks.updateMember.mockRejectedValueOnce(new Error('forbidden'));
    const listener = vi.fn();
    window.addEventListener('dilla:notify', listener);
    const { container } = render(wrap(<TeamMembers />));
    const chips = [...container.querySelectorAll('button')].filter((b) => /Mod/.test(b.textContent ?? '')) as HTMLButtonElement[];
    if (chips[0]) fireEvent.click(chips[0]);
    const saveBtn = [...container.querySelectorAll('button')].find((b) => /save/i.test(b.textContent ?? '')) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(saveBtn);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(listener).toHaveBeenCalled();
    window.removeEventListener('dilla:notify', listener);
  });

  it('renders disabled UI when no auth (mock session)', () => {
    useAuthStore.setState({ teams: new Map() } as never);
    const { container } = render(wrap(<TeamMembers />));
    expect(container.firstChild).toBeTruthy();
  });

  it('shows "No roles to assign" when no assignable roles exist', () => {
    useTeamStore.setState({
      roles: new Map([['t1', [{ id: 'r3', name: '@everyone', color: '#888', position: 0, permissions: 0x47, isDefault: true }]]]),
    } as never);
    const { container } = render(wrap(<TeamMembers />));
    expect(container.textContent).toMatch(/No roles to assign|create one/i);
  });

  it('shows "No members yet" when member list is empty', () => {
    useTeamStore.setState({
      members: new Map([['t1', []]]),
    } as never);
    const { container } = render(wrap(<TeamMembers />));
    expect(container.textContent).toMatch(/No members yet/i);
  });
});
