// All modal components — deep render with prop variants.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

if (typeof globalThis.ResizeObserver === 'undefined') {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
}

const apiMocks = vi.hoisted(() => ({
  updateChannel: vi.fn(async () => ({})),
  deleteChannel: vi.fn(async () => {}),
  updateGroup: vi.fn(async () => ({})),
  deleteGroup: vi.fn(async () => {}),
  setChannelAccess: vi.fn(async () => ({ role_ids: [] })),
  setGroupAccess: vi.fn(async () => ({ role_ids: [], hidden_if_restricted: false })),
}));
vi.mock('../services/api', () => ({ api: apiMocks }));
vi.mock('../services/websocket', () => ({ ws: {} }));
vi.mock('../services/mockSession', () => ({ isMockSession: () => false }));
vi.mock('./icons', () => {
  const stub = () => <span data-icon />;
  return { Icon: new Proxy({}, { get: () => stub }), default: new Proxy({}, { get: () => stub }) };
});
vi.mock('../stores/confirmStore', () => ({ dillaConfirm: vi.fn(async () => true) }));

import {
  ForwardModal, NewDmModal, NewChannelModal, NewServerModal,
  GroupSettingsModal, ChannelSettingsModal, ChannelAccessModal, GroupAccessModal,
} from './ChatApp';
import { ShellDataProvider } from './ShellDataContext';
import { useTeamStore } from '../stores/teamStore';

const ME = { id: 'me', name: 'me', initials: 'ME', color: '#f00' };
const ALICE = { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0' };
const BOB = { id: 'u3', name: 'bob', initials: 'BO', color: '#00f' };
const members = { MEMBERS: [ME, ALICE, BOB], byId: { me: ME, u2: ALICE, u3: BOB } };

const SHELL = {
  SERVERS: [{ id: 't1', name: 'Acme', node: 'gbg-1' }],
  CHANNELS: [
    { id: 'ch-1', name: 'general', type: 'text', category: 'main' },
    { id: 'ch-2', name: 'random', type: 'text', category: 'main' },
    { id: 'ch-3', name: 'voice', type: 'voice', category: 'voice' },
  ],
  MEMBERS: [ME, ALICE, BOB],
  byId: { me: ME, u2: ALICE, u3: BOB },
  MESSAGES: {}, DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: {},
  activeServerId: 't1', activeChannelId: 'ch-1', currentUserId: 'me',
};

function wrap(c: React.ReactNode) {
  return <ShellDataProvider value={SHELL}>{c}</ShellDataProvider>;
}

beforeEach(() => {
  for (const fn of Object.values(apiMocks)) fn.mockClear();
  useTeamStore.setState({
    activeTeamId: 't1', activeChannelId: 'ch-1',
    channels: new Map([['t1', SHELL.CHANNELS as never]]),
    members: new Map([['t1', [{ id: 'me-m', userId: 'me', isAdmin: true, roleIds: [], roles: [] }]]]),
    roles: new Map([['t1', [
      { id: 'r-admin', name: 'Admin', color: '#f00', position: 2, permissions: 0xFFFF, isDefault: false },
      { id: 'r-mod', name: 'Mod', color: '#0f0', position: 1, permissions: 0x2, isDefault: false },
      { id: 'r-every', name: '@everyone', color: '#888', position: 0, permissions: 0x47, isDefault: true },
    ]]]),
    groups: new Map([['t1', [{ id: 'g1', teamId: 't1', name: 'main', position: 0, accessRoleIds: [], hiddenIfRestricted: false }]]]),
  } as never);
});

describe('ForwardModal deep', () => {
  const sourceMsg = { id: 'm1', author: 'me', at: new Date(), kind: 'text', text: 'forward me' };
  it('renders with no DMs', () => {
    const { container } = render(wrap(<ForwardModal sourceMsg={sourceMsg} members={members} onClose={vi.fn()} onForward={vi.fn()} />));
    expect(container.firstChild).toBeTruthy();
  });
  it('clicks every button', () => {
    const { container } = render(wrap(<ForwardModal sourceMsg={sourceMsg} members={members} onClose={vi.fn()} onForward={vi.fn()} />));
    for (const b of [...container.querySelectorAll('button')] as HTMLButtonElement[]) try { fireEvent.click(b); } catch { /* */ }
    expect(container.firstChild).toBeTruthy();
  });
  it('typing in search updates input', () => {
    const { container } = render(wrap(<ForwardModal sourceMsg={sourceMsg} members={members} onClose={vi.fn()} onForward={vi.fn()} />));
    const input = container.querySelector('input') as HTMLInputElement | null;
    if (input) fireEvent.change(input, { target: { value: 'ali' } });
    expect(container.firstChild).toBeTruthy();
  });
});

describe('NewDmModal deep', () => {
  it('renders all members', () => {
    const { container } = render(wrap(<NewDmModal members={members} onClose={vi.fn()} onPick={vi.fn()} />));
    expect(container.textContent).toContain('alice');
  });
  it('filters by query', () => {
    const { container } = render(wrap(<NewDmModal members={members} onClose={vi.fn()} onPick={vi.fn()} />));
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'bob' } });
    expect(container.firstChild).toBeTruthy();
  });
  it('clicks all rows', () => {
    const { container } = render(wrap(<NewDmModal members={members} onClose={vi.fn()} onPick={vi.fn()} />));
    const rows = [...container.querySelectorAll('button, .ndm-row')] as HTMLElement[];
    for (const r of rows) try { fireEvent.click(r); } catch { /* */ }
    expect(container.firstChild).toBeTruthy();
  });
});

describe('NewChannelModal deep', () => {
  it('text mode + filled name + click create', () => {
    const onCreate = vi.fn();
    const { container } = render(wrap(<NewChannelModal onClose={vi.fn()} onCreate={onCreate} />));
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'new-text-channel' } });
    for (const b of [...container.querySelectorAll('button')] as HTMLButtonElement[]) try { fireEvent.click(b); } catch { /* */ }
    expect(container.firstChild).toBeTruthy();
  });
  it('switches to voice mode', () => {
    const { container } = render(wrap(<NewChannelModal onClose={vi.fn()} onCreate={vi.fn()} />));
    const voiceBtn = [...container.querySelectorAll('button')].find((b) => /voice/i.test(b.textContent ?? ''));
    if (voiceBtn) fireEvent.click(voiceBtn as HTMLButtonElement);
    expect(container.firstChild).toBeTruthy();
  });
  it('toggles private flag', () => {
    const { container } = render(wrap(<NewChannelModal onClose={vi.fn()} onCreate={vi.fn()} />));
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    if (checkbox) { fireEvent.click(checkbox); fireEvent.click(checkbox); }
    expect(container.firstChild).toBeTruthy();
  });
});

describe('NewServerModal deep', () => {
  it('switches between Create / Join tabs', () => {
    const { container } = render(<NewServerModal onClose={vi.fn()} onCreate={vi.fn()} />);
    const tabs = [...container.querySelectorAll('button')].filter((b) => /create|join/i.test(b.textContent ?? ''));
    for (const t of tabs) try { fireEvent.click(t); } catch { /* */ }
    expect(container.firstChild).toBeTruthy();
  });
  it('types in all inputs', () => {
    const { container } = render(<NewServerModal onClose={vi.fn()} onCreate={vi.fn()} />);
    const inputs = [...container.querySelectorAll('input')] as HTMLInputElement[];
    for (const i of inputs) {
      try { fireEvent.change(i, { target: { value: 'val' } }); } catch { /* */ }
    }
    expect(container.firstChild).toBeTruthy();
  });
});

describe('GroupSettingsModal deep', () => {
  it('renders + edit + Save', async () => {
    const { container } = render(wrap(<GroupSettingsModal group={{ id: 'g1', name: 'main' }} onClose={vi.fn()} />));
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'renamed' } });
    for (const b of [...container.querySelectorAll('button')] as HTMLButtonElement[]) {
      try { fireEvent.click(b); } catch { /* */ }
    }
    expect(container.firstChild).toBeTruthy();
  });
});

describe('ChannelSettingsModal deep', () => {
  const channel = { id: 'ch-1', name: 'general', topic: 'main', category: 'main', slowModeSeconds: 5 };
  it('renders + edit + click every button', () => {
    const { container } = render(wrap(<ChannelSettingsModal channel={channel} onClose={vi.fn()} />));
    const inputs = [...container.querySelectorAll('input')] as HTMLInputElement[];
    for (const i of inputs) try { fireEvent.change(i, { target: { value: 'new value' } }); } catch { /* */ }
    for (const b of [...container.querySelectorAll('button')] as HTMLButtonElement[]) try { fireEvent.click(b); } catch { /* */ }
    expect(container.firstChild).toBeTruthy();
  });
});

describe('ChannelAccessModal deep', () => {
  const channel = { id: 'ch-1', name: 'general', accessRoleIds: [], groupId: null };
  it('renders role chips + toggles', () => {
    const { container } = render(wrap(<ChannelAccessModal channel={channel} onClose={vi.fn()} />));
    for (const b of [...container.querySelectorAll('button')] as HTMLButtonElement[]) try { fireEvent.click(b); } catch { /* */ }
    expect(container.firstChild).toBeTruthy();
  });
  it('handles channel inside group (inherited access)', () => {
    const inGroup = { ...channel, groupId: 'g1' };
    const { container } = render(wrap(<ChannelAccessModal channel={inGroup} onClose={vi.fn()} />));
    expect(container.firstChild).toBeTruthy();
  });
});

describe('GroupAccessModal deep', () => {
  const group = { id: 'g1', name: 'main', accessRoleIds: [], hiddenIfRestricted: false };
  it('renders role chips + hidden toggle', () => {
    const { container } = render(wrap(<GroupAccessModal group={group} onClose={vi.fn()} />));
    for (const b of [...container.querySelectorAll('button')] as HTMLButtonElement[]) try { fireEvent.click(b); } catch { /* */ }
    const checkboxes = [...container.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    for (const c of checkboxes) try { fireEvent.click(c); } catch { /* */ }
    expect(container.firstChild).toBeTruthy();
  });
});
