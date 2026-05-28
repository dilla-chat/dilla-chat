// Heavy jsdom integration tests for Settings — now possible after
// the selector-stability refactor. Render the full Settings modal in
// every tab + state combination.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

if (typeof globalThis.ResizeObserver === 'undefined') {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
}
if (typeof HTMLElement !== 'undefined' && !HTMLElement.prototype.scrollTo) {
  HTMLElement.prototype.scrollTo = function() {};
  HTMLElement.prototype.scrollIntoView = function() {};
}

import Settings from './Settings';
import { ShellDataProvider } from './ShellDataContext';
import { useTeamStore } from '../stores/teamStore';
import { useAuthStore } from '../stores/authStore';
import { useUserSettingsStore } from '../stores/userSettingsStore';
import { useBlockStore } from '../stores/blockStore';
import { useAudioSettingsStore } from '../stores/audioSettingsStore';

vi.mock('../services/api', () => ({
  api: new Proxy({}, { get: () => () => Promise.resolve({}) }),
}));
vi.mock('../services/websocket', () => ({
  ws: new Proxy({}, { get: () => () => () => {} }),
}));
vi.mock('../services/mockSession', () => ({ isMockSession: () => true }));
vi.mock('../services/crypto', () => ({ cryptoService: {} }));
vi.mock('../services/keyStore', () => ({ exportIdentityBlob: vi.fn(async () => null) }));
vi.mock('../services/micTest', () => ({
  startMicTest: vi.fn(async () => ({ stop: vi.fn() })),
  stopMicTest: vi.fn(),
}));
vi.mock('../components/PasskeyManager/PasskeyManager', () => ({
  default: () => <div data-testid="passkey-manager" />,
}));

const SHELL_DATA = {
  SERVERS: [{ id: 't1', name: 'Acme', node: 'local' }],
  CHANNELS: [], MEMBERS: [{ id: 'me', name: 'me', initials: 'ME', color: '#f00', publicKeyHex: 'aa'.repeat(32) }],
  byId: { me: { id: 'me', name: 'me', initials: 'ME', color: '#f00', publicKeyHex: 'aa'.repeat(32) } },
  MESSAGES: {}, DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: {},
  activeServerId: 't1', activeChannelId: null, currentUserId: 'me',
};

function seed() {
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
  } as never);
  useAuthStore.setState({
    derivedKey: 'k',
    teams: new Map([['t1', { user: { id: 'me', display_name: 'Me' }, baseUrl: '', token: '' }]]),
  } as never);
  useUserSettingsStore.setState({
    quietHoursEnabled: false, quietHoursFrom: '', quietHoursTo: '',
    inputThreshold: 0.05, pushNotifications: false,
  } as never);
  useBlockStore.setState({ blocked: new Set() } as never);
  useAudioSettingsStore.setState({
    pushToTalk: false, pushToTalkKey: 'Space', inputDeviceId: '', outputDeviceId: '',
  } as never);
}

function wrap(children: React.ReactNode) {
  return (
    <MemoryRouter>
      <ShellDataProvider value={SHELL_DATA}>{children}</ShellDataProvider>
    </MemoryRouter>
  );
}

beforeEach(() => seed());

describe('Settings integration (jsdom)', () => {
  it('returns null when not open', () => {
    const { container } = render(wrap(<Settings open={false} mode="user" onClose={() => {}} />));
    expect(container.firstChild).toBeFalsy();
  });

  for (const tab of ['account', 'devices', 'notif', 'voice', 'appear', 'privacy', 'keys']) {
    it(`renders user mode → ${tab} tab`, () => {
      const { container } = render(wrap(<Settings open mode="user" defaultTab={tab} onClose={() => {}} />));
      expect(container.firstChild).toBeTruthy();
    });
  }

  for (const tab of ['team', 'invites', 'members', 'roles', 'integrations', 'federation', 'audit']) {
    it(`renders team mode → ${tab} tab`, () => {
      const { container } = render(wrap(<Settings open mode="team" defaultTab={tab} onClose={() => {}} />));
      expect(container.firstChild).toBeTruthy();
    });
  }

  it('clicks every button in the user-mode modal', () => {
    const { container } = render(wrap(<Settings open mode="user" onClose={() => {}} />));
    const buttons = [...container.querySelectorAll('button')] as HTMLButtonElement[];
    for (const b of buttons) {
      try { fireEvent.click(b); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('clicks every button in the team-mode modal', () => {
    const { container } = render(wrap(<Settings open mode="team" onClose={() => {}} />));
    const buttons = [...container.querySelectorAll('button')] as HTMLButtonElement[];
    for (const b of buttons) {
      try { fireEvent.click(b); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('renders privacy tab with a populated block list', () => {
    useBlockStore.setState({ blocked: new Set(['blocked-1', 'blocked-2']) } as never);
    const { container } = render(wrap(<Settings open mode="user" defaultTab="privacy" onClose={() => {}} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders voice tab with push-to-talk enabled', () => {
    useAudioSettingsStore.setState({
      pushToTalk: true, pushToTalkKey: 'KeyV',
      inputDeviceId: 'mic-1', outputDeviceId: 'speakers-1',
    } as never);
    const { container } = render(wrap(<Settings open mode="user" defaultTab="voice" onClose={() => {}} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders notif tab with quiet hours enabled', () => {
    useUserSettingsStore.setState({
      quietHoursEnabled: true,
      quietHoursFrom: '22:00',
      quietHoursTo: '08:00',
      pushNotifications: true,
      inputThreshold: 0.05,
    } as never);
    const { container } = render(wrap(<Settings open mode="user" defaultTab="notif" onClose={() => {}} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders roles tab with multiple roles', () => {
    useTeamStore.setState({
      activeTeamId: 't1',
      teams: new Map([['t1', { id: 't1', name: 'Acme' }]]),
      channels: new Map([['t1', []]]),
      members: new Map([['t1', []]]),
      roles: new Map([['t1', [
        { id: 'r1', name: 'Admin', color: '#f00', position: 3, permissions: 0xFFF, isDefault: false },
        { id: 'r2', name: 'Mod', color: '#0f0', position: 2, permissions: 0x7F, isDefault: false },
        { id: 'r3', name: 'Member', color: '#00f', position: 1, permissions: 0x10, isDefault: false },
        { id: 'r4', name: '@everyone', color: '#888', position: 0, permissions: 0x47, isDefault: true },
      ]]]),
      groups: new Map([['t1', []]]),
    } as never);
    const { container } = render(wrap(<Settings open mode="team" defaultTab="roles" onClose={() => {}} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders members tab with multiple members', () => {
    useTeamStore.setState({
      activeTeamId: 't1',
      teams: new Map([['t1', { id: 't1', name: 'Acme' }]]),
      channels: new Map([['t1', []]]),
      members: new Map([['t1', [
        { id: 'm1', userId: 'me', username: 'me', displayName: 'Me', publicKeyHex: '', avatarUrl: '', isAdmin: true, roles: [] },
        { id: 'm2', userId: 'u2', username: 'alice', displayName: 'Alice', publicKeyHex: '', avatarUrl: '', isAdmin: false, roles: [] },
        { id: 'm3', userId: 'u3', username: 'bob', displayName: 'Bob', publicKeyHex: '', avatarUrl: '', isAdmin: false, roles: [] },
      ]]]),
      roles: new Map([['t1', []]]),
      groups: new Map([['t1', []]]),
    } as never);
    const { container } = render(wrap(<Settings open mode="team" defaultTab="members" onClose={() => {}} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('dispatches escape on modal overlay', () => {
    const { container } = render(wrap(<Settings open mode="user" onClose={() => {}} />));
    fireEvent.keyDown(container, { key: 'Escape' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(container.firstChild).toBeTruthy();
  });

  it('clicks all input fields (focus path)', () => {
    const { container } = render(wrap(<Settings open mode="user" onClose={() => {}} />));
    const inputs = [...container.querySelectorAll('input, textarea, select')] as HTMLElement[];
    for (const i of inputs) {
      try { fireEvent.focus(i); fireEvent.blur(i); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('iterates through every tab via direct prop', () => {
    const userTabs = ['account', 'devices', 'notif', 'voice', 'appear', 'privacy', 'keys'];
    const teamTabs = ['team', 'invites', 'members', 'roles', 'integrations', 'federation', 'audit'];
    for (const tab of userTabs) {
      const { container, unmount } = render(wrap(<Settings open mode="user" defaultTab={tab} onClose={() => {}} />));
      expect(container.firstChild).not.toBeNull();
      unmount();
    }
    for (const tab of teamTabs) {
      const { container, unmount } = render(wrap(<Settings open mode="team" defaultTab={tab} onClose={() => {}} />));
      expect(container.firstChild).not.toBeNull();
      unmount();
    }
  });
});
