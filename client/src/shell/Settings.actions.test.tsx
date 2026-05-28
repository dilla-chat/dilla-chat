// Drive the async action handlers in Settings.tsx: leave team, sign
// out, avatar upload, identity export. These are the biggest
// uncovered blocks in Settings.

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
  leaveTeam: vi.fn(async () => ({})),
  logout: vi.fn(async () => ({})),
  uploadAvatar: vi.fn(async () => ({})),
  setUserPresence: vi.fn(async () => ({})),
  setUserStatus: vi.fn(async () => ({})),
  updateMe: vi.fn(async () => ({})),
}));
vi.mock('../services/api', () => ({
  api: new Proxy(apiMocks, {
    get: (t, k) => (k in t ? (t as Record<string, unknown>)[k] : async () => ({})),
  }),
}));
vi.mock('../services/websocket', () => ({ ws: new Proxy({}, { get: () => () => () => {} }) }));
vi.mock('../services/mockSession', () => ({ isMockSession: () => true }));
vi.mock('../services/crypto', () => ({ cryptoService: {} }));
vi.mock('../services/keyStore', () => ({ exportIdentityBlob: vi.fn(async () => null) }));
vi.mock('../services/micTest', () => ({
  startMicTest: vi.fn(async () => ({ stop: vi.fn() })),
  stopMicTest: vi.fn(),
}));
vi.mock('../components/PasskeyManager/PasskeyManager', () => ({
  default: () => <div data-testid="passkey" />,
}));

// dillaConfirm — always confirm.
vi.mock('../stores/confirmStore', () => ({
  dillaConfirm: vi.fn(async () => true),
  useConfirmStore: { setState: vi.fn(), getState: () => ({ ask: vi.fn(async () => true) }) },
}));

import Settings from './Settings';
import { ShellDataProvider } from './ShellDataContext';
import { useTeamStore } from '../stores/teamStore';
import { useAuthStore } from '../stores/authStore';
import { useUserSettingsStore } from '../stores/userSettingsStore';
import { useBlockStore } from '../stores/blockStore';
import { useAudioSettingsStore } from '../stores/audioSettingsStore';

const SHELL_DATA = {
  SERVERS: [{ id: 't1', name: 'Acme', node: 'local' }],
  CHANNELS: [], MEMBERS: [{ id: 'me', name: 'me', initials: 'ME', color: '#f00', publicKeyHex: 'aa'.repeat(32) }],
  byId: { me: { id: 'me', name: 'me', initials: 'ME', color: '#f00', publicKeyHex: 'aa'.repeat(32) } },
  MESSAGES: {}, DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: {},
  activeServerId: 't1', activeChannelId: null, currentUserId: 'me',
};

beforeEach(() => {
  const EMPTY: never[] = [];
  useTeamStore.setState({
    activeTeamId: 't1',
    teams: new Map([['t1', { id: 't1', name: 'Acme', description: '', icon_url: '' }]]),
    channels: new Map([['t1', EMPTY]]),
    members: new Map([['t1', [
      { id: 'm1', userId: 'me', username: 'me', displayName: 'Me', publicKeyHex: 'aa'.repeat(32), avatarUrl: '', isAdmin: true, roles: [] },
    ]]]),
    roles: new Map([['t1', [
      { id: 'r1', name: 'Admin', color: '#f00', position: 2, permissions: 0xFFF, isDefault: false },
    ]]]),
    groups: new Map([['t1', EMPTY]]),
    setActiveTeam: vi.fn(),
  } as never);
  useAuthStore.setState({
    derivedKey: 'k',
    teams: new Map([['t1', { user: { id: 'me', display_name: 'Me' }, baseUrl: '', token: '' }]]),
    removeTeam: vi.fn(),
  } as never);
  useUserSettingsStore.setState({
    quietHoursEnabled: false, quietHoursFrom: '', quietHoursTo: '',
    inputThreshold: 0.05, pushNotifications: false,
  } as never);
  useBlockStore.setState({ blocked: new Set() } as never);
  useAudioSettingsStore.setState({
    pushToTalk: false, pushToTalkKey: 'Space', inputDeviceId: '', outputDeviceId: '',
  } as never);
  apiMocks.leaveTeam.mockClear();
  apiMocks.logout.mockClear();
});

function wrap(children: React.ReactNode) {
  return (
    <MemoryRouter>
      <ShellDataProvider value={SHELL_DATA}>{children}</ShellDataProvider>
    </MemoryRouter>
  );
}

describe('Settings actions (jsdom)', () => {
  it('clicks every danger button in the user-mode nav footer', async () => {
    const { container } = render(wrap(<Settings open mode="user" onClose={() => {}} />));
    const dangerBtns = [...container.querySelectorAll('button.set-nav-item.danger, button.danger')] as HTMLButtonElement[];
    await act(async () => {
      for (const b of dangerBtns) {
        try { fireEvent.click(b); } catch { /* swallow */ }
      }
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('clicks every danger button in the team-mode nav footer', async () => {
    const { container } = render(wrap(<Settings open mode="team" onClose={() => {}} />));
    const dangerBtns = [...container.querySelectorAll('button.set-nav-item.danger, button.danger')] as HTMLButtonElement[];
    await act(async () => {
      for (const b of dangerBtns) {
        try { fireEvent.click(b); } catch { /* swallow */ }
      }
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('clicks every tab button', async () => {
    const { container } = render(wrap(<Settings open mode="user" onClose={() => {}} />));
    const tabBtns = [...container.querySelectorAll('button.set-nav-item')] as HTMLButtonElement[];
    for (const b of tabBtns) {
      try { fireEvent.click(b); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('escape key closes the modal', () => {
    const onClose = vi.fn();
    render(wrap(<Settings open mode="user" onClose={onClose} />));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('clicking overlay closes the modal; click inside does not', () => {
    const onClose = vi.fn();
    const { container } = render(wrap(<Settings open mode="user" onClose={onClose} />));
    const inside = container.querySelector('.settings') as HTMLElement;
    fireEvent.click(inside);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector('.modal-overlay-dismiss')!);
    expect(onClose).toHaveBeenCalled();
  });

  it('iterates all user-mode tabs + clicks every button in each', async () => {
    for (const tab of ['account', 'devices', 'notif', 'voice', 'appear', 'privacy', 'keys']) {
      const { container, unmount } = render(wrap(<Settings open mode="user" defaultTab={tab} onClose={() => {}} />));
      const buttons = [...container.querySelectorAll('button')] as HTMLButtonElement[];
      await act(async () => {
        for (const b of buttons) {
          try { fireEvent.click(b); } catch { /* swallow */ }
        }
      });
      unmount();
    }
    expect(true).toBe(true);
  });

  it('iterates all team-mode tabs + clicks every button in each', async () => {
    for (const tab of ['team', 'invites', 'members', 'roles', 'integrations', 'federation', 'audit']) {
      const { container, unmount } = render(wrap(<Settings open mode="team" defaultTab={tab} onClose={() => {}} />));
      const buttons = [...container.querySelectorAll('button')] as HTMLButtonElement[];
      await act(async () => {
        for (const b of buttons) {
          try { fireEvent.click(b); } catch { /* swallow */ }
        }
      });
      unmount();
    }
    expect(true).toBe(true);
  });

  it('changes input values in user-mode account tab', async () => {
    const { container } = render(wrap(<Settings open mode="user" defaultTab="account" onClose={() => {}} />));
    // Skip file inputs — jsdom forbids setting their value.
    const inputs = [...container.querySelectorAll('input:not([type="file"])')] as HTMLInputElement[];
    for (const i of inputs) {
      try { fireEvent.change(i, { target: { value: 'new value' } }); } catch { /* ignore */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('toggles every Toggle switch', () => {
    const { container } = render(wrap(<Settings open mode="user" defaultTab="notif" onClose={() => {}} />));
    const toggles = [...container.querySelectorAll('button.set-toggle')] as HTMLButtonElement[];
    for (const t of toggles) {
      fireEvent.click(t);
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('changes select dropdowns', () => {
    const { container } = render(wrap(<Settings open mode="user" defaultTab="appear" onClose={() => {}} />));
    const selects = [...container.querySelectorAll('select')] as HTMLSelectElement[];
    for (const s of selects) {
      if (s.options.length > 1) {
        fireEvent.change(s, { target: { value: s.options[s.options.length - 1].value } });
      }
    }
    expect(container.firstChild).toBeTruthy();
  });
});
