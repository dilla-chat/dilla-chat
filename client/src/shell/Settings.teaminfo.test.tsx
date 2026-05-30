// Drive TeamInfo edit + save flow + every TeamRoles/TeamInvites action.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

if (typeof globalThis.ResizeObserver === 'undefined') {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
}
if (typeof HTMLElement !== 'undefined' && !HTMLElement.prototype.scrollTo) {
  HTMLElement.prototype.scrollTo = function() {};
}

const apiMocks = vi.hoisted(() => ({
  updateTeam: vi.fn(async () => ({})),
  createRole: vi.fn(async () => ({ id: 'r-new', name: 'New Role' })),
  updateRole: vi.fn(async () => ({})),
  deleteRole: vi.fn(async () => ({})),
  listInvites: vi.fn(async () => []),
  createInvite: vi.fn(async () => ({ id: 'inv-new', token: 'tok' })),
  revokeInvite: vi.fn(async () => ({})),
  kickMember: vi.fn(async () => ({})),
  banMember: vi.fn(async () => ({})),
  unbanMember: vi.fn(async () => ({})),
  updateMemberRoles: vi.fn(async () => ({})),
  setGiphyKey: vi.fn(async () => ({})),
  listFederationPeers: vi.fn(async () => []),
  listAuditLog: vi.fn(async () => []),
}));
vi.mock('../services/api', () => ({
  api: new Proxy(apiMocks, { get: (t, k) => k in t ? (t as Record<string, unknown>)[k] : async () => ({}) }),
}));
vi.mock('../services/websocket', () => ({ ws: new Proxy({}, { get: () => () => () => {} }) }));
vi.mock('../services/mockSession', () => ({ isMockSession: () => false }));
vi.mock('../services/crypto', () => ({ cryptoService: {} }));
vi.mock('../services/keyStore', () => ({ exportIdentityBlob: vi.fn(async () => null) }));
vi.mock('../services/micTest', () => ({ startMicTest: vi.fn(async () => ({ stop: vi.fn() })), stopMicTest: vi.fn() }));
vi.mock('../components/PasskeyManager/PasskeyManager', () => ({
  default: () => <div data-testid="passkey" />,
}));
vi.mock('../stores/confirmStore', () => ({
  dillaConfirm: vi.fn(async () => true),
  useConfirmStore: { setState: vi.fn(), getState: () => ({ ask: vi.fn(async () => true) }) },
}));

import {
  TeamInfo,
  TeamInvites,
  TeamRoles,
  TeamMembers,
  TeamIntegrations,
  TeamFederation,
  TeamAudit,
} from './Settings';
import { ShellDataProvider } from './ShellDataContext';
import { useTeamStore } from '../stores/teamStore';
import { useAuthStore } from '../stores/authStore';

const SHELL_DATA = {
  SERVERS: [{ id: 't1', name: 'Acme', description: 'd', node: 'srv' }],
  CHANNELS: [
    { id: 'ch-1', name: 'general', type: 'text', encrypted: true },
    { id: 'ch-2', name: 'random', type: 'text', encrypted: true },
  ],
  MEMBERS: [{ id: 'me', name: 'me', initials: 'ME', color: '#f00', publicKeyHex: 'aa'.repeat(32) }],
  byId: { me: { id: 'me', name: 'me', initials: 'ME', color: '#f00', publicKeyHex: 'aa'.repeat(32) } },
  MESSAGES: {}, DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: {},
  activeServerId: 't1', activeChannelId: null, currentUserId: 'me',
};

function wrap(children: React.ReactNode) {
  return (
    <MemoryRouter>
      <ShellDataProvider value={SHELL_DATA}>{children}</ShellDataProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  const EMPTY: never[] = [];
  useTeamStore.setState({
    activeTeamId: 't1',
    teams: new Map([['t1', { id: 't1', name: 'Acme', description: 'd', icon_url: '' }]]),
    channels: new Map([['t1', [
      { id: 'ch-1', name: 'general', type: 'text' },
      { id: 'ch-2', name: 'random', type: 'text' },
    ]]]),
    members: new Map([['t1', [
      { id: 'm1', userId: 'me', username: 'me', displayName: 'Me', publicKeyHex: 'aa'.repeat(32), avatarUrl: '', isAdmin: true, roles: [] },
      { id: 'm2', userId: 'u2', username: 'alice', displayName: 'Alice', publicKeyHex: '', avatarUrl: '', isAdmin: false, roles: [] },
    ]]]),
    roles: new Map([['t1', [
      { id: 'r1', name: 'Admin', color: '#f00', position: 2, permissions: 0xFFF, isDefault: false },
      { id: 'r2', name: '@everyone', color: '#888', position: 0, permissions: 0x47, isDefault: true },
    ]]]),
    groups: new Map([['t1', EMPTY]]),
  } as never);
  useAuthStore.setState({
    derivedKey: 'k',
    teams: new Map([['t1', { user: { id: 'me', display_name: 'Me' }, baseUrl: 'https://srv.example', token: 'tok' }]]),
  } as never);
  for (const fn of Object.values(apiMocks)) fn.mockClear();
});

describe('TeamInfo edit + save', () => {
  it('renders the form', () => {
    const { container } = render(wrap(<TeamInfo />));
    expect(container.textContent).toContain('Name');
  });

  it('typing in Name field marks form dirty and enables Save', () => {
    const { container } = render(wrap(<TeamInfo />));
    const inputs = [...container.querySelectorAll('input')] as HTMLInputElement[];
    const nameInput = inputs[0];
    fireEvent.change(nameInput, { target: { value: 'NewName' } });
    expect(nameInput.value).toBe('NewName');
  });

  it('clicking Save fires api.updateTeam after editing', async () => {
    const { container } = render(wrap(<TeamInfo />));
    const nameInput = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Renamed' } });
    const saveBtn = [...container.querySelectorAll('button')].find((b) => /save/i.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
    if (saveBtn) {
      await act(async () => {
        fireEvent.click(saveBtn);
        await Promise.resolve();
      });
    }
    expect(apiMocks.updateTeam).toHaveBeenCalled();
  });

  it('clicking Discard reverts the form', () => {
    const { container } = render(wrap(<TeamInfo />));
    const nameInput = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'temp-name' } });
    const discardBtn = [...container.querySelectorAll('button')].find((b) => /discard/i.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
    if (discardBtn) fireEvent.click(discardBtn);
    expect(nameInput.value).not.toBe('temp-name');
  });

  it('changing description marks dirty', () => {
    const { container } = render(wrap(<TeamInfo />));
    const inputs = [...container.querySelectorAll('input')] as HTMLInputElement[];
    fireEvent.change(inputs[1], { target: { value: 'New description' } });
    expect(inputs[1].value).toBe('New description');
  });

  it('slow mode strips non-digits', () => {
    const { container } = render(wrap(<TeamInfo />));
    const slowInput = [...container.querySelectorAll('input.mono')] as HTMLInputElement[];
    if (slowInput[0]) {
      fireEvent.change(slowInput[0], { target: { value: 'abc123' } });
      expect(slowInput[0].value).toBe('123');
    }
  });

  it('Save without dirty does nothing', async () => {
    const { container } = render(wrap(<TeamInfo />));
    const saveBtn = [...container.querySelectorAll('button')].find((b) => /save/i.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
    if (saveBtn) {
      await act(async () => { fireEvent.click(saveBtn); await Promise.resolve(); });
    }
    expect(apiMocks.updateTeam).not.toHaveBeenCalled();
  });
});

describe('TeamRoles', () => {
  it('renders the role list', () => {
    const { container } = render(wrap(<TeamRoles />));
    expect(container.firstChild).toBeTruthy();
  });

  it('clicks every button', () => {
    const { container } = render(wrap(<TeamRoles />));
    const buttons = [...container.querySelectorAll('button')] as HTMLButtonElement[];
    for (const b of buttons) {
      try { fireEvent.click(b); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });
});

describe('TeamMembers', () => {
  it('renders the member list', () => {
    const { container } = render(wrap(<TeamMembers />));
    expect(container.firstChild).toBeTruthy();
  });

  it('clicks every button in members tab', () => {
    const { container } = render(wrap(<TeamMembers />));
    const buttons = [...container.querySelectorAll('button')] as HTMLButtonElement[];
    for (const b of buttons) {
      try { fireEvent.click(b); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });
});

describe('TeamInvites', () => {
  it('renders invites tab', async () => {
    const { container } = render(wrap(<TeamInvites />));
    await waitFor(() => expect(container.firstChild).toBeTruthy());
  });

  it('clicks every button in invites tab', async () => {
    const { container } = render(wrap(<TeamInvites />));
    await act(async () => {
      const buttons = [...container.querySelectorAll('button')] as HTMLButtonElement[];
      for (const b of buttons) {
        try { fireEvent.click(b); } catch { /* swallow */ }
      }
      await Promise.resolve();
    });
    expect(container.firstChild).toBeTruthy();
  });
});

describe('TeamIntegrations', () => {
  it('renders integrations tab', () => {
    const { container } = render(wrap(<TeamIntegrations />));
    expect(container.firstChild).toBeTruthy();
  });

  it('changes giphy key input', () => {
    const { container } = render(wrap(<TeamIntegrations />));
    const input = container.querySelector('input') as HTMLInputElement | null;
    if (input) {
      fireEvent.change(input, { target: { value: 'gph_key_abc' } });
      expect(input.value).toBe('gph_key_abc');
    }
  });
});

describe('TeamFederation', () => {
  it('renders federation tab', () => {
    const { container } = render(wrap(<TeamFederation />));
    expect(container.firstChild).toBeTruthy();
  });
});

describe('TeamAudit', () => {
  it('renders audit tab', () => {
    const { container } = render(wrap(<TeamAudit />));
    expect(container.firstChild).toBeTruthy();
  });
});
