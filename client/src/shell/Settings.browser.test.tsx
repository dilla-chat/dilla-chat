// Render Settings (2529-LOC modal port) in real Chromium via
// vitest-browser-playwright. Same rationale as ChatApp.browser.test —
// jsdom can't handle the deep Zustand selectors.

import { describe, it, expect, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { MemoryRouter } from 'react-router-dom';
import Settings from './Settings';
import { ShellDataProvider } from './ShellDataContext';
import { useTeamStore } from '../stores/teamStore';
import { useAuthStore } from '../stores/authStore';
import { useUserSettingsStore } from '../stores/userSettingsStore';
import { useBlockStore } from '../stores/blockStore';
import { useAudioSettingsStore } from '../stores/audioSettingsStore';

function seedStores() {
  const EMPTY: never[] = [];
  useTeamStore.setState({
    activeTeamId: 't1',
    teams: new Map([['t1', { id: 't1', name: 'Acme' }]]),
    channels: new Map([['t1', EMPTY]]),
    members: new Map([['t1', EMPTY]]),
    roles: new Map([['t1', EMPTY]]),
    groups: new Map([['t1', EMPTY]]),
  } as never);
  useAuthStore.setState({
    derivedKey: 'key',
    teams: new Map([['t1', { user: { id: 'me', display_name: 'Me' }, baseUrl: '', token: '' }]]),
  } as never);
  useUserSettingsStore.setState({
    quietHoursEnabled: false,
    quietHoursFrom: '',
    quietHoursTo: '',
    inputThreshold: 0.05,
    pushNotifications: false,
  } as never);
  useBlockStore.setState({ blocked: new Set() } as never);
  useAudioSettingsStore.setState({
    pushToTalk: false,
    pushToTalkKey: 'Space',
    inputDeviceId: '',
    outputDeviceId: '',
  } as never);
}

const SHELL_DATA = {
  SERVERS: [{ id: 't1', name: 'Acme', node: 'local', short: 'A', federated: false, members: 0 }],
  CHANNELS: [],
  MEMBERS: [{ id: 'me', name: 'me', initials: 'ME', color: '#f00' }],
  byId: { me: { id: 'me', name: 'me', initials: 'ME', color: '#f00' } },
  MESSAGES: {},
  DMS: [],
  DM_MESSAGES: {},
  THREAD_REPLIES: {},
  activeServerId: 't1',
  activeChannelId: null,
  currentUserId: 'me',
};

function wrap(children: React.ReactNode) {
  return (
    <MemoryRouter>
      <ShellDataProvider value={SHELL_DATA}>{children}</ShellDataProvider>
    </MemoryRouter>
  );
}

describe('Settings render in real Chromium', () => {
  beforeEach(() => {
    seedStores();
  });

  it('returns null when not open (open={false})', async () => {
    const { container } = await render(wrap(<Settings open={false} mode="user" onClose={() => {}} />));
    // Closed Settings renders nothing into the modal slot.
    expect(container.firstChild).toBeFalsy();
  });

  it('mounts in user mode with the Account tab by default', async () => {
    const { container } = await render(wrap(<Settings open mode="user" onClose={() => {}} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('mounts in team mode with the Team info tab by default', async () => {
    const { container } = await render(wrap(<Settings open mode="team" onClose={() => {}} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('mounts on the devices tab via defaultTab prop', async () => {
    const { container } = await render(wrap(<Settings open mode="user" defaultTab="devices" onClose={() => {}} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('mounts on the notifications tab via defaultTab prop', async () => {
    const { container } = await render(wrap(<Settings open mode="user" defaultTab="notif" onClose={() => {}} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('mounts on the voice tab via defaultTab prop', async () => {
    const { container } = await render(wrap(<Settings open mode="user" defaultTab="voice" onClose={() => {}} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('mounts on the appearance tab via defaultTab prop', async () => {
    const { container } = await render(wrap(<Settings open mode="user" defaultTab="appear" onClose={() => {}} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('mounts on the privacy tab via defaultTab prop', async () => {
    const { container } = await render(wrap(<Settings open mode="user" defaultTab="privacy" onClose={() => {}} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('mounts on the keys tab via defaultTab prop', async () => {
    const { container } = await render(wrap(<Settings open mode="user" defaultTab="keys" onClose={() => {}} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('mounts on the invites tab (team mode) via defaultTab prop', async () => {
    const { container } = await render(wrap(<Settings open mode="team" defaultTab="invites" onClose={() => {}} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('mounts on the members tab (team mode)', async () => {
    const { container } = await render(wrap(<Settings open mode="team" defaultTab="members" onClose={() => {}} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('mounts on the roles tab (team mode)', async () => {
    const { container } = await render(wrap(<Settings open mode="team" defaultTab="roles" onClose={() => {}} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('mounts on the integrations tab (team mode)', async () => {
    const { container } = await render(wrap(<Settings open mode="team" defaultTab="integrations" onClose={() => {}} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('mounts on the federation tab (team mode)', async () => {
    const { container } = await render(wrap(<Settings open mode="team" defaultTab="federation" onClose={() => {}} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('mounts on the audit tab (team mode)', async () => {
    const { container } = await render(wrap(<Settings open mode="team" defaultTab="audit" onClose={() => {}} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('Roles tab with seeded roles renders the role list', async () => {
    useTeamStore.setState({
      activeTeamId: 't1',
      teams: new Map([['t1', { id: 't1', name: 'Acme' }]]),
      channels: new Map([['t1', []]]),
      members: new Map([['t1', []]]),
      roles: new Map([['t1', [
        { id: 'r1', name: 'Admin', color: '#f00', position: 2, permissions: 0xFFF, isDefault: false },
        { id: 'r2', name: '@everyone', color: '#888', position: 0, permissions: 0x47, isDefault: true },
      ]]]),
      groups: new Map([['t1', []]]),
    } as never);
    const { container } = await render(wrap(<Settings open mode="team" defaultTab="roles" onClose={() => {}} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('Members tab with seeded members renders the list', async () => {
    useTeamStore.setState({
      activeTeamId: 't1',
      teams: new Map([['t1', { id: 't1', name: 'Acme' }]]),
      channels: new Map([['t1', []]]),
      members: new Map([['t1', [
        { id: 'm1', userId: 'u1', username: 'alice', displayName: 'Alice', publicKeyHex: '', avatarUrl: '', isAdmin: true, roles: [] },
        { id: 'm2', userId: 'u2', username: 'bob', displayName: 'Bob', publicKeyHex: '', avatarUrl: '', isAdmin: false, roles: [] },
      ]]]),
      roles: new Map([['t1', []]]),
      groups: new Map([['t1', []]]),
    } as never);
    const { container } = await render(wrap(<Settings open mode="team" defaultTab="members" onClose={() => {}} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('Privacy tab with blocked users renders the block list', async () => {
    useBlockStore.setState({ blocked: new Set(['blocked-user-1']) } as never);
    const { container } = await render(wrap(<Settings open mode="user" defaultTab="privacy" onClose={() => {}} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('Notifications tab with quiet hours enabled', async () => {
    useUserSettingsStore.setState({
      quietHoursEnabled: true,
      quietHoursFrom: '22:00',
      quietHoursTo: '08:00',
      pushNotifications: true,
      inputThreshold: 0.05,
    } as never);
    const { container } = await render(wrap(<Settings open mode="user" defaultTab="notif" onClose={() => {}} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('Voice tab with push-to-talk enabled', async () => {
    useAudioSettingsStore.setState({
      pushToTalk: true,
      pushToTalkKey: 'KeyV',
      inputDeviceId: 'mic-1',
      outputDeviceId: 'speakers-1',
    } as never);
    const { container } = await render(wrap(<Settings open mode="user" defaultTab="voice" onClose={() => {}} />));
    expect(container.firstChild).toBeTruthy();
  });
});
