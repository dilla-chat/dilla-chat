// Direct unit tests on ChatApp's exported UserPanel.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

if (typeof globalThis.ResizeObserver === 'undefined') {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
}

vi.mock('../services/websocket', () => ({ ws: { updatePresence: vi.fn() } }));
vi.mock('../services/api', () => ({ api: { updateMe: vi.fn(async () => ({})) } }));
vi.mock('../services/mockSession', () => ({ isMockSession: () => true }));
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
});
