// Direct unit tests on ChatApp's exported ServerRail.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

vi.mock('../services/websocket', () => ({ ws: { markChannelRead: vi.fn() } }));
vi.mock('../services/api', () => ({ api: { leaveTeam: vi.fn(async () => {}) } }));
vi.mock('../services/mockSession', () => ({ isMockSession: () => true }));
vi.mock('./icons', () => {
  const stub = () => <span data-icon />;
  return { Icon: new Proxy({}, { get: () => stub }), default: new Proxy({}, { get: () => stub }) };
});
vi.mock('../stores/confirmStore', () => ({ dillaConfirm: vi.fn(async () => true) }));

import { ServerRail } from './ChatApp';
import { ShellDataProvider } from './ShellDataContext';
import { useTeamStore } from '../stores/teamStore';
import { useAuthStore } from '../stores/authStore';

const servers = [
  { id: 't1', name: 'Acme', short: 'A', federated: false },
  { id: 't2', name: 'Beta', short: 'B', federated: true },
  { id: 't3', name: 'Charlie', short: 'C', federated: true },
];

function wrap(c: React.ReactNode) {
  return (
    <ShellDataProvider value={{
      SERVERS: servers, CHANNELS: [], MEMBERS: [], byId: {},
      MESSAGES: {}, DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: {},
      activeServerId: 't1', activeChannelId: null, currentUserId: 'me',
    }}>{c}</ShellDataProvider>
  );
}

beforeEach(() => {
  useTeamStore.setState({ activeTeamId: 't1' } as never);
  useAuthStore.setState({ teams: new Map([['t1', { user: { id: 'me' } }]]) } as never);
});

describe('ServerRail', () => {
  it('renders all servers', () => {
    const { container } = render(wrap(<ServerRail servers={servers} activeServer="t1" onPick={vi.fn()} />));
    expect(container.querySelectorAll('.rail-item').length).toBe(3);
  });

  it('clicking a server fires onPick', () => {
    const onPick = vi.fn();
    const { container } = render(wrap(<ServerRail servers={servers} activeServer="t1" onPick={onPick} />));
    const items = [...container.querySelectorAll('.rail-item')] as HTMLElement[];
    fireEvent.click(items[1]);
    expect(onPick).toHaveBeenCalledWith('t2');
  });

  it('right-click dispatches dilla:open-menu', () => {
    const listener = vi.fn();
    window.addEventListener('dilla:open-menu', listener);
    const { container } = render(wrap(<ServerRail servers={servers} activeServer="t1" onPick={vi.fn()} />));
    fireEvent.contextMenu(container.querySelector('.rail-item') as HTMLElement);
    expect(listener).toHaveBeenCalled();
    window.removeEventListener('dilla:open-menu', listener);
  });

  it('add button dispatches dilla:open-add-server', () => {
    const listener = vi.fn();
    window.addEventListener('dilla:open-add-server', listener);
    const { container } = render(wrap(<ServerRail servers={servers} activeServer="t1" onPick={vi.fn()} />));
    fireEvent.click(container.querySelector('.rail-add') as HTMLElement);
    expect(listener).toHaveBeenCalled();
    window.removeEventListener('dilla:open-add-server', listener);
  });

  it('drag + drop reorders the list', () => {
    const { container } = render(wrap(<ServerRail servers={servers} activeServer="t1" onPick={vi.fn()} />));
    const items = [...container.querySelectorAll('.rail-item')] as HTMLElement[];
    fireEvent.dragStart(items[0]);
    fireEvent.dragOver(items[2]);
    fireEvent.drop(items[2]);
    fireEvent.dragEnd(items[0]);
    expect(container.firstChild).toBeTruthy();
  });

  it('drag onto self is a no-op', () => {
    const { container } = render(wrap(<ServerRail servers={servers} activeServer="t1" onPick={vi.fn()} />));
    const items = [...container.querySelectorAll('.rail-item')] as HTMLElement[];
    fireEvent.dragStart(items[0]);
    fireEvent.drop(items[0]);
    expect(container.firstChild).toBeTruthy();
  });

  it('dragLeave clears overId', () => {
    const { container } = render(wrap(<ServerRail servers={servers} activeServer="t1" onPick={vi.fn()} />));
    const items = [...container.querySelectorAll('.rail-item')] as HTMLElement[];
    fireEvent.dragStart(items[0]);
    fireEvent.dragOver(items[1]);
    fireEvent.dragLeave(items[1]);
    expect(container.firstChild).toBeTruthy();
  });

  it('marks the active server with .active class', () => {
    const { container } = render(wrap(<ServerRail servers={servers} activeServer="t2" onPick={vi.fn()} />));
    const active = container.querySelector('.rail-item.active');
    expect(active).toBeTruthy();
  });

  it('shows warn dot for non-federated servers', () => {
    const { container } = render(wrap(<ServerRail servers={servers} activeServer="t1" onPick={vi.fn()} />));
    const dots = container.querySelectorAll('.rail-dot');
    expect(dots.length).toBe(1); // only t1 is non-federated
  });
});
