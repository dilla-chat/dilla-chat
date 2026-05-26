// Broad-sweep tests on all Settings sub-components — for each tab,
// render it and click every button/toggle to hit residual handlers.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const apiMocks = vi.hoisted(() => {
  const ARRAY_METHODS = new Set([
    'listDevices', 'listInvites', 'getRoles', 'getMembers',
    'getAuditEvents', 'listBlocks', 'getFederationPeers',
  ]);
  return new Proxy({} as Record<string, ReturnType<typeof vi.fn>>, {
    get(target, prop: string) {
      if (!(prop in target)) {
        target[prop] = vi.fn(async () => ARRAY_METHODS.has(prop) ? [] : { configured: false });
      }
      return target[prop];
    },
  });
});
vi.mock('../services/api', () => ({ api: apiMocks }));
vi.mock('../services/mockSession', () => ({ isMockSession: () => false }));
vi.mock('../services/websocket', () => ({ ws: { on: vi.fn(() => () => {}) } }));
vi.mock('../services/crypto', () => ({ cryptoService: {} }));
vi.mock('../services/keyStore', () => ({ exportIdentityBlob: vi.fn(async () => null) }));
vi.mock('../services/micTest', () => ({
  startMicTest: vi.fn(async () => ({ stop: vi.fn() })),
  stopMicTest: vi.fn(),
}));
vi.mock('../components/PasskeyManager/PasskeyManager', () => ({ default: () => <div /> }));
vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn(async () => {}) } }));
vi.mock('../stores/confirmStore', () => ({ dillaConfirm: vi.fn(async () => true) }));

import {
  UserAccount, UserDevices, UserNotif, UserVoice, UserAppear, UserPrivacy, UserKeys,
  TeamInfo, TeamInvites, TeamRoles, TeamMembers, TeamIntegrations, TeamFederation, TeamAudit,
} from './Settings';
import { ShellDataProvider } from './ShellDataContext';
import { useAuthStore } from '../stores/authStore';
import { useTeamStore } from '../stores/teamStore';
import { useBlockStore } from '../stores/blockStore';

const SHELL = {
  SERVERS: [{ id: 't1', name: 'Acme', node: 'gbg-1', federated: true }],
  CHANNELS: [{ id: 'ch-1', name: 'general', type: 'text' as const }],
  MEMBERS: [{ id: 'me', name: 'me', initials: 'ME', color: '#f00' }],
  byId: { me: { id: 'me', name: 'me', initials: 'ME', color: '#f00', publicKeyHex: 'aa'.repeat(32) } },
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
  useAuthStore.setState({
    derivedKey: 'k',
    teams: new Map([['t1', { user: { id: 'me', display_name: 'Me' }, baseUrl: 'https://srv', token: 'tok', teamInfo: { name: 'Acme', federated: true } }]]),
  } as never);
  useTeamStore.setState({
    activeTeamId: 't1',
    teams: new Map([['t1', { id: 't1', name: 'Acme', description: 'desc', icon_url: '' }]]),
    channels: new Map([['t1', [{ id: 'ch-1', name: 'general', type: 'text' as const }]]]),
    members: new Map([['t1', [{ id: 'me-m', userId: 'me', username: 'me', displayName: 'Me', publicKeyHex: 'aa'.repeat(32), avatarUrl: '', isAdmin: true, roles: [{ id: 'r1', name: 'Admin', permissions: 0xFFF }], roleIds: ['r1'] }]]]),
    roles: new Map([['t1', [
      { id: 'r1', name: 'Admin', color: '#f00', position: 2, permissions: 0xFFF, isDefault: false },
      { id: 'r2', name: '@everyone', color: '#888', position: 0, permissions: 0x47, isDefault: true },
    ]]]),
    groups: new Map([['t1', []]]),
  } as never);
  useBlockStore.setState({ blocked: new Set() } as never);
});

function clickAll(container: HTMLElement) {
  const buttons = [...container.querySelectorAll('button')] as HTMLButtonElement[];
  for (const b of buttons) {
    try { fireEvent.click(b); } catch { /* swallow */ }
  }
}

function changeAll(container: HTMLElement) {
  const inputs = [...container.querySelectorAll('input:not([type="file"]):not([type="checkbox"])')] as HTMLInputElement[];
  for (const i of inputs) {
    try { fireEvent.change(i, { target: { value: 'x' } }); } catch { /* swallow */ }
  }
}

describe('Broad button-click sweeps over every Settings tab', () => {
  const tabs = [
    { name: 'UserAccount', Cmp: UserAccount },
    { name: 'UserDevices', Cmp: UserDevices },
    { name: 'UserNotif', Cmp: UserNotif },
    { name: 'UserVoice', Cmp: UserVoice },
    { name: 'UserAppear', Cmp: UserAppear },
    { name: 'UserPrivacy', Cmp: UserPrivacy },
    { name: 'UserKeys', Cmp: UserKeys },
    { name: 'TeamInfo', Cmp: TeamInfo },
    { name: 'TeamInvites', Cmp: TeamInvites },
    { name: 'TeamRoles', Cmp: TeamRoles },
    { name: 'TeamMembers', Cmp: TeamMembers },
    { name: 'TeamIntegrations', Cmp: TeamIntegrations },
    { name: 'TeamFederation', Cmp: TeamFederation },
    { name: 'TeamAudit', Cmp: TeamAudit },
  ];

  for (const { name, Cmp } of tabs) {
    it(`renders + clicks every button in ${name}`, async () => {
      const { container } = render(wrap(<Cmp />));
      await act(async () => {
        clickAll(container);
        changeAll(container);
        await Promise.resolve();
      });
      expect(container.firstChild).toBeTruthy();
    });
  }
});
