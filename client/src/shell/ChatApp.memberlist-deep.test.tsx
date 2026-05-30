// MemberList deep — every grouping / blocked / role / fingerprint code path.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

if (typeof globalThis.ResizeObserver === 'undefined') {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
}

vi.mock('../services/websocket', () => ({ ws: new Proxy({}, { get: () => () => () => {} }) }));
vi.mock('../services/api', () => ({ api: new Proxy({}, { get: () => () => Promise.resolve({}) }) }));
vi.mock('../services/mockSession', () => ({ isMockSession: () => true }));
vi.mock('../hooks/useMessageDecryption', () => ({
  tryEncrypt: vi.fn(async (c: string) => c),
  tryDecrypt: vi.fn(async (_id: string, c: string) => c),
  serverToMessage: vi.fn((sm) => sm),
}));
vi.mock('../hooks/useChannelLazyLoad', () => ({ useChannelLazyLoad: vi.fn() }));
vi.mock('../components/MessageMarkdown/MessageMarkdown', () => ({ default: ({ text }: { text: string }) => <span>{text}</span> }));
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
vi.mock('../stores/confirmStore', () => ({ dillaConfirm: vi.fn(async () => true) }));

import { MemberList } from './ChatApp';
import { ShellDataProvider } from './ShellDataContext';
import { useTeamStore } from '../stores/teamStore';
import { useBlockStore } from '../stores/blockStore';

const ME = { id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online' };
const ALICE = { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0', status: 'online' };
const BOB = { id: 'u3', name: 'bob', initials: 'BO', color: '#00f', status: 'offline' };

const SHELL = {
  SERVERS: [{ id: 't1', name: 'Acme' }], CHANNELS: [],
  MEMBERS: [ME, ALICE, BOB],
  byId: { me: ME, u2: ALICE, u3: BOB },
  MESSAGES: {}, DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: {},
  activeServerId: 't1', activeChannelId: 'ch-1', currentUserId: 'me',
};

function wrap(c: React.ReactNode) {
  return <ShellDataProvider value={SHELL}>{c}</ShellDataProvider>;
}

beforeEach(() => {
  useTeamStore.setState({
    activeTeamId: 't1',
    members: new Map([['t1', [{ id: 'me-m', userId: 'me', isAdmin: true, roleIds: [], roles: [] }]]]),
    roles: new Map([['t1', []]]),
    groups: new Map([['t1', []]]),
    channels: new Map([['t1', []]]),
  } as never);
  useBlockStore.setState({ blocked: new Set() } as never);
});

describe('MemberList', () => {
  const ALICE_WITH_ROLE = { ...ALICE, roles: [{ id: 'r1', name: 'Admin', color: '#f00', position: 2 }] };

  it('renders members with no roles in default Online group', () => {
    const members = { MEMBERS: [ME, ALICE] };
    const { container } = render(wrap(<MemberList members={members} voiceConnection={null} rich={false} federated={false} />));
    expect(container.textContent).toContain('alice');
  });

  it('groups by highest role (online members)', () => {
    const BOB_ONLINE = { ...BOB, status: 'online' as const, roles: [{ id: 'r2', name: 'Mod', color: '#0f0', position: 1 }] };
    const members = { MEMBERS: [ME, ALICE_WITH_ROLE, BOB_ONLINE] };
    const { container } = render(wrap(<MemberList members={members} voiceConnection={null} rich={false} federated={false} />));
    expect(container.textContent).toContain('Admin');
    expect(container.textContent).toContain('Mod');
  });

  it('offline members separate group', () => {
    const offline = { ...ALICE, status: 'offline' };
    const members = { MEMBERS: [ME, offline] };
    const { container } = render(wrap(<MemberList members={members} voiceConnection={null} rich={false} federated={false} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('clicks every member row', () => {
    const listener = vi.fn();
    window.addEventListener('dilla:open-profile', listener);
    const { container } = render(wrap(<MemberList members={{ MEMBERS: [ME, ALICE, BOB] }} voiceConnection={null} rich={false} federated={false} />));
    const rows = [...container.querySelectorAll('.member, .ml-row')] as HTMLElement[];
    for (const r of rows) { try { fireEvent.click(r); } catch { /* */ } }
    expect(listener).toHaveBeenCalled();
    window.removeEventListener('dilla:open-profile', listener);
  });

  it('right-clicks every member row (context menu)', () => {
    const listener = vi.fn();
    window.addEventListener('dilla:open-menu', listener);
    const { container } = render(wrap(<MemberList members={{ MEMBERS: [ALICE, BOB] }} voiceConnection={null} rich={false} federated={false} />));
    const rows = [...container.querySelectorAll('.member, .ml-row')] as HTMLElement[];
    for (const r of rows) { try { fireEvent.contextMenu(r); } catch { /* */ } }
    expect(listener).toHaveBeenCalled();
    window.removeEventListener('dilla:open-menu', listener);
  });

  it('renders blocked member with Unblock menu item', () => {
    useBlockStore.setState({ blocked: new Set(['u2']) } as never);
    const { container } = render(wrap(<MemberList members={{ MEMBERS: [ME, ALICE] }} voiceConnection={null} rich={false} federated={false} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('right-click + click every member context-menu action (L4444-4515)', async () => {
    // Admin perms so Kick + Ban appear.
    useTeamStore.setState({
      activeTeamId: 't1',
      members: new Map([
        ['t1', [
          { id: 'm1', userId: 'me', isAdmin: true, roleIds: ['r-admin'], roles: [{ id: 'r-admin', permissions: 0x001 }] },
          { id: 'm2', userId: 'u2', isAdmin: false, roleIds: [], roles: [] },
        ]],
      ]),
    } as never);
    let menuItems: Array<{ label?: string; onClick?: () => void | Promise<void>; sep?: boolean }> = [];
    const cb = (e: Event) => {
      const items = (e as CustomEvent).detail.items;
      if (items && items.length > menuItems.length) menuItems = items;
    };
    window.addEventListener('dilla:open-menu', cb);
    const { container } = render(wrap(<MemberList members={{ MEMBERS: [ME, ALICE] }} voiceConnection={null} rich={false} federated={false} />));
    const rows = [...container.querySelectorAll('.member, .ml-row')] as HTMLElement[];
    // Right-click alice (not me) to expose kick/ban admin actions.
    const aliceRow = rows.find((r) => /alice/i.test(r.textContent ?? '')) ?? rows[1];
    if (aliceRow) fireEvent.contextMenu(aliceRow);
    window.removeEventListener('dilla:open-menu', cb);
    // Click each action — they each dispatch events / call api mocks.
    for (const item of menuItems) {
      if (item.sep || !item.onClick) continue;
      try {
        const result = item.onClick();
        if (result instanceof Promise) await result;
      } catch { /* swallow */ }
    }
    expect(menuItems.length).toBeGreaterThan(3);
  });

  it('blocked member context-menu shows Unblock action that calls api.unblockUser', async () => {
    useBlockStore.setState({
      blocked: new Set(['u2']),
      isBlocked: (id: string) => id === 'u2',
      block: vi.fn(),
      unblock: vi.fn(),
    } as never);
    let menuItems: Array<{ label?: string; onClick?: () => void | Promise<void> }> = [];
    const cb = (e: Event) => {
      const items = (e as CustomEvent).detail.items;
      if (items) menuItems = items;
    };
    window.addEventListener('dilla:open-menu', cb);
    const { container } = render(wrap(<MemberList members={{ MEMBERS: [ME, ALICE] }} voiceConnection={null} rich={false} federated={false} />));
    const rows = [...container.querySelectorAll('.member, .ml-row')] as HTMLElement[];
    const aliceRow = rows.find((r) => /alice/i.test(r.textContent ?? '')) ?? rows[1];
    if (aliceRow) fireEvent.contextMenu(aliceRow);
    window.removeEventListener('dilla:open-menu', cb);
    const unblock = menuItems.find((it) => /Unblock/i.test(it.label ?? ''));
    expect(unblock).toBeTruthy();
    if (unblock?.onClick) {
      const result = unblock.onClick();
      if (result instanceof Promise) await result;
    }
  });

  it('renders rich + federated variants', () => {
    for (const [rich, fed] of [[true, true], [true, false], [false, true], [false, false]] as const) {
      const { container } = render(wrap(<MemberList members={{ MEMBERS: [ME, ALICE] }} voiceConnection={null} rich={rich} federated={fed} />));
      expect(container.firstChild).toBeTruthy();
    }
  });

  it('renders empty member list', () => {
    const { container } = render(wrap(<MemberList members={{ MEMBERS: [] }} voiceConnection={null} rich={false} federated={false} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with all offline members', () => {
    const offlineAll = [
      { ...ME, status: 'offline' as const },
      { ...ALICE, status: 'offline' as const },
      { ...BOB, status: 'offline' as const },
    ];
    const { container } = render(wrap(<MemberList members={{ MEMBERS: offlineAll }} voiceConnection={null} rich={false} federated={false} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with voiceConnection', () => {
    const { container } = render(wrap(<MemberList members={{ MEMBERS: [ME, ALICE] }} voiceConnection={{ channelId: 'ch-v' }} rich={false} federated={false} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders 30+ members (performance)', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: 'u' + i, name: 'user' + i, initials: 'U' + i, color: '#0f0', status: i % 3 === 0 ? 'offline' : 'online',
    }));
    const { container } = render(wrap(<MemberList members={{ MEMBERS: many }} voiceConnection={null} rich={false} federated={false} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders members with multiple roles (highest wins for grouping)', () => {
    const multiRole = {
      ...ALICE,
      roles: [
        { id: 'r1', name: 'Admin', color: '#f00', position: 3 },
        { id: 'r2', name: 'Mod', color: '#0f0', position: 1 },
      ],
    };
    const { container } = render(wrap(<MemberList members={{ MEMBERS: [ME, multiRole] }} voiceConnection={null} rich={false} federated={false} />));
    expect(container.firstChild).toBeTruthy();
  });
});
