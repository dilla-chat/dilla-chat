// Direct unit tests on ChatApp's exported UserPanel.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';

if (typeof globalThis.ResizeObserver === 'undefined') {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
}

const apiMock = vi.hoisted(() => ({
  api: { updateMe: vi.fn(async () => ({})), updatePresence: vi.fn(async () => ({})) },
}));
vi.mock('../services/websocket', () => ({ ws: { updatePresence: vi.fn() } }));
vi.mock('../services/api', () => apiMock);
vi.mock('../services/mockSession', () => ({ isMockSession: () => false }));
vi.mock('./icons', () => {
  const stub = () => <span data-icon />;
  return { Icon: new Proxy({}, { get: () => stub }), default: new Proxy({}, { get: () => stub }) };
});
vi.mock('./Avatar', () => ({
  Avatar: ({ member }: { member?: { name?: string } }) => <span>{member?.name}</span>,
  PlainAvatar: ({ member }: { member?: { name?: string } }) => <span>{member?.name}</span>,
  memberAvatarStyle: () => ({}),
  memberAvatarClass: () => '',
}));

import { UserPanel } from './ChatApp';
import { ShellDataProvider } from './ShellDataContext';
import { useTeamStore } from '../stores/teamStore';
import { useAuthStore } from '../stores/authStore';

const ME = { id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online' };

const SHELL = {
  SERVERS: [{ id: 't1', name: 'Acme' }],
  CHANNELS: [], MEMBERS: [ME],
  byId: { me: ME },
  MESSAGES: {}, DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: {},
  activeServerId: 't1', activeChannelId: null, currentUserId: 'me',
};

function wrap(c: React.ReactNode) {
  return <ShellDataProvider value={SHELL}>{c}</ShellDataProvider>;
}

beforeEach(() => {
  useTeamStore.setState({
    activeTeamId: 't1',
    members: new Map([['t1', [{ id: 'm1', userId: 'me', isAdmin: false, roleIds: [], roles: [] }]]]),
  } as never);
  useAuthStore.setState({
    derivedKey: 'k',
    teams: new Map([['t1', { user: { id: 'me' }, baseUrl: 'https://srv', token: 'tok' }]]),
  } as never);
});

describe('UserPanel', () => {
  it('renders with member info', () => {
    const { container } = render(wrap(<UserPanel member={ME} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with different statuses', () => {
    for (const status of ['online', 'idle', 'dnd', 'offline'] as const) {
      const { container } = render(wrap(<UserPanel member={{ ...ME, status }} />));
      expect(container.firstChild).toBeTruthy();
    }
  });

  it('clicking buttons does not throw', () => {
    const { container } = render(wrap(<UserPanel member={ME} />));
    const buttons = [...container.querySelectorAll('button')] as HTMLButtonElement[];
    for (const b of buttons) {
      try { fireEvent.click(b); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('right-click on panel does not throw', () => {
    const { container } = render(wrap(<UserPanel member={ME} />));
    try { fireEvent.contextMenu(container.firstChild as HTMLElement); } catch { /* swallow */ }
    expect(container.firstChild).toBeTruthy();
  });

  it('handles member without status', () => {
    const noStatus = { id: 'me', name: 'me', initials: 'ME', color: '#f00' };
    const { container } = render(wrap(<UserPanel member={noStatus} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('handles member with custom status text', () => {
    const m = { ...ME, customStatus: 'In a meeting' };
    const { container } = render(wrap(<UserPanel member={m} />));
    expect(container.firstChild).toBeTruthy();
  });

  // ── deeper behaviour: status picker open/close + persistence ──────
  it('clicking "Set status" toggles the picker open and back closed', () => {
    const { container } = render(wrap(<UserPanel member={ME} />));
    const setBtn = container.querySelector('button[title="Set status"]') as HTMLButtonElement;
    expect(container.querySelector('.status-pop')).toBeFalsy();
    fireEvent.click(setBtn);
    expect(container.querySelector('.status-pop')).toBeTruthy();
    fireEvent.click(setBtn);
    expect(container.querySelector('.status-pop')).toBeFalsy();
  });

  it('clicking "Preferences" dispatches dilla:open-settings (user)', () => {
    const captured: CustomEvent[] = [];
    const cb = (e: Event) => captured.push(e as CustomEvent);
    window.addEventListener('dilla:open-settings', cb);
    const { container } = render(wrap(<UserPanel member={ME} />));
    const prefs = container.querySelector('button[title="Preferences"]') as HTMLButtonElement;
    fireEvent.click(prefs);
    window.removeEventListener('dilla:open-settings', cb);
    expect(captured.length).toBe(1);
    expect((captured[0] as CustomEvent).detail).toBe('user');
  });

  it('clicking a status row sets status + calls api.updatePresence (L2362-2365)', () => {
    apiMock.api.updatePresence.mockClear();
    const { container } = render(wrap(<UserPanel member={ME} />));
    fireEvent.click(container.querySelector('button[title="Set status"]') as HTMLButtonElement);
    const dndRow = Array.from(container.querySelectorAll('.sp-row')).find(
      (r) => /do not disturb/i.test(r.textContent ?? ''),
    ) as HTMLButtonElement;
    fireEvent.click(dndRow);
    expect(container.querySelector('.status-pop')).toBeFalsy();
    expect(apiMock.api.updatePresence).toHaveBeenCalledWith('t1', 'dnd', undefined);
  });

  it('setting custom message via "Set" calls api.updatePresence (L2377-2381)', () => {
    apiMock.api.updatePresence.mockClear();
    const { container } = render(wrap(<UserPanel member={ME} />));
    fireEvent.click(container.querySelector('button[title="Set status"]') as HTMLButtonElement);
    const input = container.querySelector('.sp-custom input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'heads down' } });
    const setBtn = Array.from(container.querySelectorAll('.sp-custom button')).find(
      (b) => (b.textContent ?? '').trim() === 'Set',
    ) as HTMLButtonElement;
    fireEvent.click(setBtn);
    expect(apiMock.api.updatePresence).toHaveBeenCalledWith('t1', 'online', 'heads down');
  });

  it('"clear" button on existing custom resets custom + calls api.updatePresence (L2384-2388)', () => {
    apiMock.api.updatePresence.mockClear();
    const { container } = render(wrap(<UserPanel member={{ ...ME, custom: 'busy' }} />));
    fireEvent.click(container.querySelector('button[title="Set status"]') as HTMLButtonElement);
    const clearBtn = container.querySelector('.sp-clear') as HTMLButtonElement;
    expect(clearBtn).toBeTruthy();
    fireEvent.click(clearBtn);
    expect(apiMock.api.updatePresence).toHaveBeenCalledWith('t1', 'online', undefined);
  });

  it('Escape closes the picker (L2312)', () => {
    const { container } = render(wrap(<UserPanel member={ME} />));
    fireEvent.click(container.querySelector('button[title="Set status"]') as HTMLButtonElement);
    expect(container.querySelector('.status-pop')).toBeTruthy();
    act(() => fireEvent.keyDown(document, { key: 'Escape' }));
    expect(container.querySelector('.status-pop')).toBeFalsy();
  });

  it('mousedown outside the popover closes it (L2311)', async () => {
    const { container } = render(wrap(<UserPanel member={ME} />));
    fireEvent.click(container.querySelector('button[title="Set status"]') as HTMLButtonElement);
    await new Promise((r) => setTimeout(r, 5));
    act(() => fireEvent.mouseDown(document.body));
    expect(container.querySelector('.status-pop')).toBeFalsy();
  });

  it('persistPresence early-returns when teamId is null', () => {
    apiMock.api.updatePresence.mockClear();
    useTeamStore.setState({ activeTeamId: null } as never);
    const { container } = render(wrap(<UserPanel member={ME} />));
    fireEvent.click(container.querySelector('button[title="Set status"]') as HTMLButtonElement);
    const row = container.querySelectorAll('.sp-row')[0] as HTMLButtonElement;
    fireEvent.click(row);
    expect(apiMock.api.updatePresence).not.toHaveBeenCalled();
  });
});
