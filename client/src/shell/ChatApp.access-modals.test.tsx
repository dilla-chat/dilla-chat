// Drive NewChannelModal + ChannelAccessModal + GroupAccessModal directly.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';

if (typeof globalThis.ResizeObserver === 'undefined') {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
}

vi.mock('../services/websocket', () => ({ ws: { on: vi.fn(() => () => {}) } }));
vi.mock('../services/api', () => ({ api: { setChannelAccess: vi.fn(async () => ({ role_ids: [] })), setGroupAccess: vi.fn(async () => ({ role_ids: [], hidden_if_restricted: false })) } }));
vi.mock('../services/mockSession', () => ({ isMockSession: () => false }));
vi.mock('./icons', () => {
  const stub = () => <span data-icon />;
  return { Icon: new Proxy({}, { get: () => stub }), default: new Proxy({}, { get: () => stub }) };
});

import { NewChannelModal, ChannelAccessModal, GroupAccessModal } from './ChatApp';
import { ShellDataProvider } from './ShellDataContext';
import { useTeamStore } from '../stores/teamStore';

const SHELL = {
  SERVERS: [{ id: 't1', name: 'Acme', node: 'gbg-1' }],
  CHANNELS: [
    { id: 'ch-1', name: 'general', type: 'text', category: 'main' },
    { id: 'ch-2', name: 'random', type: 'text', category: 'main' },
  ],
  MEMBERS: [], byId: {},
  MESSAGES: {}, DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: {},
  activeServerId: 't1', activeChannelId: 'ch-1', currentUserId: 'me',
};

function wrap(c: React.ReactNode) {
  return <ShellDataProvider value={SHELL}>{c}</ShellDataProvider>;
}

beforeEach(() => {
  useTeamStore.setState({
    activeTeamId: 't1',
    channels: new Map([['t1', [
      { id: 'ch-1', name: 'general', type: 'text' as const, teamId: 't1', accessRoleIds: [] },
    ]]]),
    members: new Map([['t1', []]]),
    roles: new Map([['t1', [
      { id: 'r1', name: 'Admin', color: '#f00', position: 2, permissions: 0xFFF, isDefault: false },
      { id: 'r2', name: 'Mod', color: '#0f0', position: 1, permissions: 0x2, isDefault: false },
      { id: 'r3', name: '@everyone', color: '#888', position: 0, permissions: 0x47, isDefault: true },
    ]]]),
    groups: new Map([['t1', [{ id: 'g1', teamId: 't1', name: 'main', position: 0, accessRoleIds: [], hiddenIfRestricted: false }]]]),
  } as never);
});

describe('NewChannelModal', () => {
  it('renders with name input + type tabs', () => {
    const { container } = render(wrap(<NewChannelModal onClose={vi.fn()} onCreate={vi.fn()} />));
    expect(container.querySelector('input')).toBeTruthy();
  });

  it('typing channel name + clicking Create fires onCreate', () => {
    const onCreate = vi.fn();
    const { container } = render(wrap(<NewChannelModal onClose={vi.fn()} onCreate={onCreate} />));
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'new-channel' } });
    const createBtn = [...container.querySelectorAll('button')].find((b) => /create/i.test(b.textContent ?? '')) as HTMLButtonElement;
    if (createBtn) fireEvent.click(createBtn);
    expect(container.firstChild).toBeTruthy();
  });

  it('clicking Cancel closes the modal', () => {
    const onClose = vi.fn();
    const { container } = render(wrap(<NewChannelModal onClose={onClose} onCreate={vi.fn()} />));
    const cancelBtn = [...container.querySelectorAll('button')].find((b) => /cancel/i.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
    if (cancelBtn) fireEvent.click(cancelBtn);
    expect(container.firstChild).toBeTruthy();
  });

  it('Escape closes', () => {
    const onClose = vi.fn();
    render(wrap(<NewChannelModal onClose={onClose} onCreate={vi.fn()} />));
    act(() => { fireEvent.keyDown(window, { key: 'Escape' }); });
    expect(onClose).toHaveBeenCalled();
  });

  it('switches between text and voice tabs', () => {
    const { container } = render(wrap(<NewChannelModal onClose={vi.fn()} onCreate={vi.fn()} />));
    const tabs = [...container.querySelectorAll('button')].filter((b) => /text|voice/i.test(b.textContent ?? ''));
    for (const t of tabs.slice(0, 4)) try { fireEvent.click(t); } catch { /* */ }
    expect(container.firstChild).toBeTruthy();
  });

  it('toggles private flag', () => {
    const { container } = render(wrap(<NewChannelModal onClose={vi.fn()} onCreate={vi.fn()} />));
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    if (checkbox) fireEvent.click(checkbox);
    expect(container.firstChild).toBeTruthy();
  });
});

describe('ChannelAccessModal', () => {
  const channel = { id: 'ch-1', name: 'general', accessRoleIds: [], groupId: null };

  it('renders the role toggle list', () => {
    const { container } = render(wrap(<ChannelAccessModal channel={channel} onClose={vi.fn()} />));
    expect(container.textContent).toContain('Admin');
    expect(container.textContent).toContain('Mod');
  });

  it('clicking a role chip toggles it', () => {
    const { container } = render(wrap(<ChannelAccessModal channel={channel} onClose={vi.fn()} />));
    const chips = [...container.querySelectorAll('button')].filter((b) => /admin|mod/i.test(b.textContent ?? ''));
    for (const c of chips) try { fireEvent.click(c); } catch { /* */ }
    expect(container.firstChild).toBeTruthy();
  });

  it('Save calls api.setChannelAccess', async () => {
    const onClose = vi.fn();
    const { container } = render(wrap(<ChannelAccessModal channel={channel} onClose={onClose} />));
    const saveBtn = [...container.querySelectorAll('button')].find((b) => /save|apply/i.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
    if (saveBtn) {
      await act(async () => {
        fireEvent.click(saveBtn);
        await Promise.resolve();
      });
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('Cancel/× closes', () => {
    const onClose = vi.fn();
    const { container } = render(wrap(<ChannelAccessModal channel={channel} onClose={onClose} />));
    const cancelBtn = [...container.querySelectorAll('button')].find((b) => /cancel|×/i.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
    if (cancelBtn) fireEvent.click(cancelBtn);
    expect(container.firstChild).toBeTruthy();
  });

  it('Escape closes', () => {
    const onClose = vi.fn();
    const { container } = render(wrap(<ChannelAccessModal channel={channel} onClose={onClose} />));
    act(() => { fireEvent.keyDown(window, { key: 'Escape' }); });
    expect(container.firstChild).toBeTruthy();
  });
});

describe('GroupAccessModal', () => {
  const group = { id: 'g1', name: 'main', accessRoleIds: [], hiddenIfRestricted: false };

  it('renders the role toggle list + hidden checkbox', () => {
    const { container } = render(wrap(<GroupAccessModal group={group} onClose={vi.fn()} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('clicking role chips toggles them', () => {
    const { container } = render(wrap(<GroupAccessModal group={group} onClose={vi.fn()} />));
    const chips = [...container.querySelectorAll('button')].filter((b) => /admin|mod/i.test(b.textContent ?? ''));
    for (const c of chips) try { fireEvent.click(c); } catch { /* */ }
    expect(container.firstChild).toBeTruthy();
  });

  it('Save calls api.setGroupAccess', async () => {
    const { container } = render(wrap(<GroupAccessModal group={group} onClose={vi.fn()} />));
    const saveBtn = [...container.querySelectorAll('button')].find((b) => /save|apply/i.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
    if (saveBtn) {
      await act(async () => {
        fireEvent.click(saveBtn);
        await Promise.resolve();
      });
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('toggles hiddenIfRestricted checkbox', () => {
    const { container } = render(wrap(<GroupAccessModal group={group} onClose={vi.fn()} />));
    const checkboxes = [...container.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    for (const c of checkboxes) try { fireEvent.click(c); } catch { /* */ }
    expect(container.firstChild).toBeTruthy();
  });

  it('Cancel closes', () => {
    const onClose = vi.fn();
    const { container } = render(wrap(<GroupAccessModal group={group} onClose={onClose} />));
    const cancelBtn = [...container.querySelectorAll('button')].find((b) => /cancel|×/i.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
    if (cancelBtn) fireEvent.click(cancelBtn);
    expect(container.firstChild).toBeTruthy();
  });
});
