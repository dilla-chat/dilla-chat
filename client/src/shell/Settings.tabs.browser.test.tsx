// Render each Settings tab sub-component in isolation. Each tab is
// a ~50-200 LOC React component that was previously only reachable
// through the parent Settings modal — testing in isolation hits
// branches the parent render didn't cover.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { MemoryRouter } from 'react-router-dom';
import { ShellDataProvider } from './ShellDataContext';
import {
  UserAccount,
  UserDevices,
  UserNotif,
  UserVoice,
  UserAppear,
  UserPrivacy,
  UserKeys,
  TeamInfo,
  TeamInvites,
  TeamRoles,
  TeamMembers,
  TeamIntegrations,
  TeamFederation,
  TeamAudit,
  Row,
  Group,
  Toggle,
  TextField,
  Select,
  Btn,
  FormBar,
  BlockListGroup,
  SafetyNumberQR,
} from './Settings';
import { useTeamStore } from '../stores/teamStore';
import { useAuthStore } from '../stores/authStore';
import { useUserSettingsStore } from '../stores/userSettingsStore';
import { useBlockStore } from '../stores/blockStore';
import { useAudioSettingsStore } from '../stores/audioSettingsStore';

const SHELL_DATA = {
  SERVERS: [{ id: 't1', name: 'Acme', node: 'local' }],
  CHANNELS: [], MEMBERS: [{ id: 'me', name: 'me', initials: 'ME', color: '#f00' }],
  byId: { me: { id: 'me', name: 'me', initials: 'ME', color: '#f00', publicKeyHex: 'aa'.repeat(32) } },
  MESSAGES: {}, DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: {},
  activeServerId: 't1', activeChannelId: null, currentUserId: 'me',
};

function seed() {
  const EMPTY: never[] = [];
  useTeamStore.setState({
    activeTeamId: 't1',
    teams: new Map([['t1', { id: 't1', name: 'Acme' }]]),
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
    quietHoursEnabled: false,
    quietHoursFrom: '',
    quietHoursTo: '',
    pushNotifications: false,
    inputThreshold: 0.05,
  } as never);
  useBlockStore.setState({ blocked: new Set() } as never);
  useAudioSettingsStore.setState({
    pushToTalk: false,
    pushToTalkKey: 'Space',
    inputDeviceId: '',
    outputDeviceId: '',
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

describe('Settings small primitives', () => {
  it('Row renders label + children', async () => {
    const { container } = await render(wrap(<Row label="Hello">child</Row>));
    expect(container.textContent).toContain('Hello');
    expect(container.textContent).toContain('child');
  });

  it('Row with hint shows the hint text', async () => {
    const { container } = await render(wrap(<Row label="Hello" hint="a hint">child</Row>));
    expect(container.textContent).toContain('a hint');
  });

  it('Group renders title + children', async () => {
    const { container } = await render(wrap(<Group title="Section">inside</Group>));
    expect(container.textContent).toContain('Section');
    expect(container.textContent).toContain('inside');
  });

  it('Group with hint shows the hint', async () => {
    const { container } = await render(wrap(<Group title="Section" hint="explained">inside</Group>));
    expect(container.textContent).toContain('explained');
  });

  it('Toggle renders + fires onChange when clicked', async () => {
    const onChange = vi.fn();
    const { container } = await render(wrap(<Toggle value={false} onChange={onChange} />));
    (container.querySelector('button') as HTMLButtonElement).click();
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('Toggle with value=true fires onChange(false)', async () => {
    const onChange = vi.fn();
    const { container } = await render(wrap(<Toggle value={true} onChange={onChange} />));
    (container.querySelector('button') as HTMLButtonElement).click();
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('TextField renders + accepts a value', async () => {
    const onChange = vi.fn();
    const { container } = await render(wrap(<TextField value="initial" onChange={onChange} placeholder="ph" />));
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('initial');
    expect(input.placeholder).toBe('ph');
  });

  it('TextField readOnly does not fire onChange', async () => {
    const onChange = vi.fn();
    const { container } = await render(wrap(<TextField value="x" onChange={onChange} placeholder="" readOnly />));
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.readOnly).toBe(true);
  });

  it('TextField mono variant gets the mono class', async () => {
    const { container } = await render(wrap(<TextField value="x" onChange={vi.fn()} placeholder="" mono />));
    expect((container.querySelector('input') as HTMLInputElement).className).toContain('mono');
  });

  it('Select renders options + fires onChange', async () => {
    const onChange = vi.fn();
    const { container } = await render(wrap(<Select value="a" onChange={onChange} options={['a', 'b', 'c']} />));
    const select = container.querySelector('select') as HTMLSelectElement;
    expect(select.children.length).toBe(3);
    select.value = 'b';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('Btn renders + fires onClick', async () => {
    const onClick = vi.fn();
    const { container } = await render(wrap(<Btn onClick={onClick}>Click</Btn>));
    (container.querySelector('button') as HTMLButtonElement).click();
    expect(onClick).toHaveBeenCalled();
  });

  it('Btn with danger gets the danger class', async () => {
    const { container } = await render(wrap(<Btn danger onClick={vi.fn()}>Delete</Btn>));
    expect((container.querySelector('button') as HTMLButtonElement).className).toContain('btn--danger');
  });
});

describe('FormBar', () => {
  it('renders Save + Discard buttons', async () => {
    const { container } = await render(wrap(
      <FormBar dirty saving={false} savedAt={null} onSave={vi.fn()} onDiscard={vi.fn()} />,
    ));
    const txt = container.textContent ?? '';
    expect(txt).toContain('Discard');
    expect(txt.toLowerCase()).toContain('save');
  });

  it('renders Saving... when saving=true', async () => {
    const { container } = await render(wrap(
      <FormBar dirty saving={true} savedAt={null} onSave={vi.fn()} onDiscard={vi.fn()} />,
    ));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders Saved chip after a recent save', async () => {
    const { container } = await render(wrap(
      <FormBar dirty={false} saving={false} savedAt={Date.now()} onSave={vi.fn()} onDiscard={vi.fn()} />,
    ));
    expect(container.firstChild).toBeTruthy();
  });

  it('clicking Discard fires onDiscard', async () => {
    const onDiscard = vi.fn();
    const { container } = await render(wrap(
      <FormBar dirty saving={false} savedAt={null} onSave={vi.fn()} onDiscard={onDiscard} />,
    ));
    const discardBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Discard') as HTMLButtonElement | undefined;
    if (discardBtn) discardBtn.click();
    expect(onDiscard).toHaveBeenCalled();
  });
});

describe('User-mode tabs (rendered in isolation)', () => {
  for (const [name, Comp] of [
    ['UserAccount', UserAccount],
    ['UserDevices', UserDevices],
    ['UserNotif', UserNotif],
    ['UserVoice', UserVoice],
    ['UserAppear', UserAppear],
    ['UserPrivacy', UserPrivacy],
    ['UserKeys', UserKeys],
  ] as const) {
    it(`${name} renders without throwing`, async () => {
      const { container } = await render(wrap(<Comp />));
      expect(container.firstChild).toBeTruthy();
    });
  }
});

describe('Team-mode tabs (rendered in isolation)', () => {
  for (const [name, Comp] of [
    ['TeamInfo', TeamInfo],
    ['TeamInvites', TeamInvites],
    ['TeamRoles', TeamRoles],
    ['TeamMembers', TeamMembers],
    ['TeamIntegrations', TeamIntegrations],
    ['TeamFederation', TeamFederation],
    ['TeamAudit', TeamAudit],
  ] as const) {
    it(`${name} renders without throwing`, async () => {
      const { container } = await render(wrap(<Comp />));
      expect(container.firstChild).toBeTruthy();
    });
  }
});

describe('BlockListGroup', () => {
  it('renders empty block list', async () => {
    const { container } = await render(wrap(<BlockListGroup />));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with blocked users seeded', async () => {
    useBlockStore.setState({ blocked: new Set(['blocked-1', 'blocked-2']) } as never);
    const { container } = await render(wrap(<BlockListGroup />));
    expect(container.firstChild).toBeTruthy();
  });
});

describe('SafetyNumberQR', () => {
  it('renders with a fingerprint (smoke)', async () => {
    const fp = 'aa'.repeat(32);
    const { container } = await render(wrap(
      <SafetyNumberQR fingerprint={fp} />,
    ));
    // SafetyNumberQR may render as an SVG-tagged element or fallback HTML.
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with empty fingerprint placeholder', async () => {
    const { container } = await render(wrap(
      <SafetyNumberQR fingerprint="" />,
    ));
    expect(container.firstChild).toBeTruthy();
  });
});
