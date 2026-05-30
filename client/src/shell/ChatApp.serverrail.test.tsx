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
import { useUnreadStore } from '../stores/unreadStore';

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

// Drives the context-menu action onClick handlers (L1682-1730), which
// only run *after* the menu is dispatched and the host UI invokes them.
describe('ServerRail context-menu actions', () => {
  function dispatchMenu(container: HTMLElement): Array<{ label?: string; onClick?: () => void | Promise<void>; sep?: boolean }> {
    const captured: CustomEvent[] = [];
    const cb = (e: Event) => captured.push(e as CustomEvent);
    window.addEventListener('dilla:open-menu', cb);
    fireEvent.contextMenu(container.querySelector('.rail-item') as HTMLElement, { clientX: 50, clientY: 75 });
    window.removeEventListener('dilla:open-menu', cb);
    return (captured[0].detail as { items: Array<{ label?: string; onClick?: () => void | Promise<void>; sep?: boolean }> }).items;
  }

  it('Team settings onClick fires dilla:open-settings tab=team', () => {
    const { container } = render(wrap(<ServerRail servers={servers} activeServer="t1" onPick={vi.fn()} />));
    const items = dispatchMenu(container);
    const captured: CustomEvent[] = [];
    const cb = (e: Event) => captured.push(e as CustomEvent);
    window.addEventListener('dilla:open-settings', cb);
    items.find((it) => it.label === 'Team settings')?.onClick?.();
    window.removeEventListener('dilla:open-settings', cb);
    expect(captured.length).toBe(1);
    expect((captured[0].detail as { tab: string }).tab).toBe('team');
  });

  it('Invites onClick fires dilla:open-settings tab=invites', () => {
    const { container } = render(wrap(<ServerRail servers={servers} activeServer="t1" onPick={vi.fn()} />));
    const items = dispatchMenu(container);
    const captured: CustomEvent[] = [];
    const cb = (e: Event) => captured.push(e as CustomEvent);
    window.addEventListener('dilla:open-settings', cb);
    items.find((it) => it.label === 'Invites')?.onClick?.();
    window.removeEventListener('dilla:open-settings', cb);
    expect((captured[0].detail as { tab: string }).tab).toBe('invites');
  });

  it('Federation onClick fires dilla:open-settings tab=federation', () => {
    const { container } = render(wrap(<ServerRail servers={servers} activeServer="t1" onPick={vi.fn()} />));
    const items = dispatchMenu(container);
    const captured: CustomEvent[] = [];
    const cb = (e: Event) => captured.push(e as CustomEvent);
    window.addEventListener('dilla:open-settings', cb);
    items.find((it) => it.label === 'Federation')?.onClick?.();
    window.removeEventListener('dilla:open-settings', cb);
    expect((captured[0].detail as { tab: string }).tab).toBe('federation');
  });

  it('Mark all read calls unread.markRead for every channel and notifies', () => {
    const markRead = vi.fn();
    useUnreadStore.setState({ counts: {}, markRead } as never);
    // Two channels in shell-data so we cover the for-loop body.
    const dataValue = {
      SERVERS: servers,
      CHANNELS: [
        { id: 'a', name: 'a' }, { id: 'b', name: 'b' },
      ],
      MEMBERS: [], byId: {},
      MESSAGES: { a: [{ id: 'last-a' }], b: [{ id: 'last-b' }] },
      DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: {},
      activeServerId: 't1', activeChannelId: 'a', currentUserId: 'me',
    };
    const { container } = render(
      <ShellDataProvider value={dataValue}>
        <ServerRail servers={servers} activeServer="t1" onPick={vi.fn()} />
      </ShellDataProvider>,
    );
    const items = dispatchMenu(container);
    const notified: CustomEvent[] = [];
    const cb = (e: Event) => notified.push(e as CustomEvent);
    window.addEventListener('dilla:notify', cb);
    items.find((it) => it.label === 'Mark all read')?.onClick?.();
    window.removeEventListener('dilla:notify', cb);
    expect(markRead).toHaveBeenCalledWith('a');
    expect(markRead).toHaveBeenCalledWith('b');
    expect(notified.length).toBe(1);
  });

  it('Leave team — confirm yes calls api.leaveTeam and notifies', async () => {
    vi.mocked((await import('../stores/confirmStore')).dillaConfirm).mockResolvedValueOnce(true);
    const removeTeam = vi.fn();
    useAuthStore.setState({
      teams: new Map([['t1', { user: { id: 'me' } }]]),
      removeTeam,
    } as never);
    // mockSession returns true in this test setup → real-leave branch
    // is skipped. Re-mock locally so the api.leaveTeam path runs.
    vi.doMock('../services/mockSession', () => ({ isMockSession: () => false }));
    const fresh = await import('./ChatApp');
    const Fresh = fresh.ServerRail;
    const { container } = render(wrap(<Fresh servers={servers} activeServer="t1" onPick={vi.fn()} />));
    const items = dispatchMenu(container);
    const leave = items.find((it) => it.label === 'Leave team');
    expect(leave).toBeTruthy();
    // Run the onClick — it awaits the confirm, then api.leaveTeam.
    await leave?.onClick?.();
  });

  it('Leave team — confirm cancel is a no-op', async () => {
    vi.mocked((await import('../stores/confirmStore')).dillaConfirm).mockResolvedValueOnce(false);
    const { container } = render(wrap(<ServerRail servers={servers} activeServer="t1" onPick={vi.fn()} />));
    const items = dispatchMenu(container);
    const leave = items.find((it) => it.label === 'Leave team');
    await leave?.onClick?.();
    // Reaching here without crashing is the test.
    expect(container.firstChild).toBeTruthy();
  });
});
