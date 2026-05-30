// Drive RoleEditor edit/save/permission-toggle flow.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const apiMocks = vi.hoisted(() => ({
  updateRole: vi.fn(async () => ({})),
}));
vi.mock('../services/api', () => ({ api: apiMocks }));
vi.mock('../services/mockSession', () => ({ isMockSession: () => false }));
vi.mock('../services/websocket', () => ({ ws: { on: vi.fn(() => () => {}) } }));

import { RoleEditor } from './Settings';
import { ShellDataProvider } from './ShellDataContext';
import { useTeamStore } from '../stores/teamStore';

const SHELL = {
  SERVERS: [], CHANNELS: [],
  MEMBERS: [{ id: 'me', name: 'me', initials: 'ME', color: '#f00' }],
  byId: { me: { id: 'me', name: 'me', initials: 'ME', color: '#f00' } },
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
  apiMocks.updateRole.mockClear();
  useTeamStore.setState({
    activeTeamId: 't1',
    members: new Map([['t1', [{ id: 'me-m', userId: 'me', isAdmin: true, roleIds: ['r-admin'], roles: [{ id: 'r-admin', name: 'Admin', permissions: 0xFFFF }] }]]]),
    roles: new Map([['t1', []]]),
  } as never);
});

const ROLE = { id: 'r1', name: 'Moderator', color: '#7a9aa7', permissions: 0x0 };

describe('RoleEditor', () => {
  it('returns null when role is null', () => {
    const { container } = render(wrap(<RoleEditor teamId="t1" role={null} onClose={vi.fn()} onSaved={vi.fn()} />));
    expect(container.firstChild).toBeNull();
  });

  it('renders the edit form with role name', () => {
    const { container } = render(wrap(<RoleEditor teamId="t1" role={ROLE} onClose={vi.fn()} onSaved={vi.fn()} />));
    expect(container.textContent).toContain('Edit role');
    const nameInput = container.querySelector('input.set-input') as HTMLInputElement;
    expect(nameInput?.value).toBe('Moderator');
  });

  it('typing changes the name', () => {
    const { container } = render(wrap(<RoleEditor teamId="t1" role={ROLE} onClose={vi.fn()} onSaved={vi.fn()} />));
    const nameInput = container.querySelector('input.set-input') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Super Mod' } });
    expect(nameInput.value).toBe('Super Mod');
  });

  it('color picker change updates color', () => {
    const { container } = render(wrap(<RoleEditor teamId="t1" role={ROLE} onClose={vi.fn()} onSaved={vi.fn()} />));
    const colorInput = container.querySelector('input[type="color"]') as HTMLInputElement;
    fireEvent.change(colorInput, { target: { value: '#ff0000' } });
    expect(colorInput.value).toBe('#ff0000');
  });

  it('toggling a permission checkbox flips it', () => {
    const { container } = render(wrap(<RoleEditor teamId="t1" role={ROLE} onClose={vi.fn()} onSaved={vi.fn()} />));
    const checkboxes = [...container.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    if (checkboxes[0]) {
      const before = checkboxes[0].checked;
      fireEvent.click(checkboxes[0]);
      expect(checkboxes[0].checked).toBe(!before);
    }
  });

  it('clicking Save fires api.updateRole + onSaved', async () => {
    const onSaved = vi.fn();
    const { container } = render(wrap(<RoleEditor teamId="t1" role={ROLE} onClose={vi.fn()} onSaved={onSaved} />));
    const saveBtn = [...container.querySelectorAll('button')].find((b) => /save/i.test(b.textContent ?? '')) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(saveBtn);
      await Promise.resolve();
    });
    expect(apiMocks.updateRole).toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalled();
  });

  it('clicking Cancel fires onClose', () => {
    const onClose = vi.fn();
    const { container } = render(wrap(<RoleEditor teamId="t1" role={ROLE} onClose={onClose} onSaved={vi.fn()} />));
    const cancelBtn = [...container.querySelectorAll('button')].find((b) => /cancel/i.test(b.textContent ?? '')) as HTMLButtonElement;
    fireEvent.click(cancelBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it('clicking ✕ fires onClose', () => {
    const onClose = vi.fn();
    const { container } = render(wrap(<RoleEditor teamId="t1" role={ROLE} onClose={onClose} onSaved={vi.fn()} />));
    fireEvent.click(container.querySelector('.set-x') as HTMLElement);
    expect(onClose).toHaveBeenCalled();
  });

  it('clicking the backdrop closes; clicks inside the panel do not', () => {
    const onClose = vi.fn();
    const { container } = render(wrap(<RoleEditor teamId="t1" role={ROLE} onClose={onClose} onSaved={vi.fn()} />));
    fireEvent.click(container.querySelector('.set-modal') as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector('.modal-overlay-dismiss') as HTMLElement);
    expect(onClose).toHaveBeenCalled();
  });

  it('save error dispatches dilla:notify', async () => {
    apiMocks.updateRole.mockRejectedValueOnce(new Error('forbidden'));
    const listener = vi.fn();
    window.addEventListener('dilla:notify', listener);
    const { container } = render(wrap(<RoleEditor teamId="t1" role={ROLE} onClose={vi.fn()} onSaved={vi.fn()} />));
    const saveBtn = [...container.querySelectorAll('button')].find((b) => /save/i.test(b.textContent ?? '')) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(saveBtn);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(listener).toHaveBeenCalled();
    window.removeEventListener('dilla:notify', listener);
  });

  it('Save button disables while saving', async () => {
    // Make updateRole hang
    let resolveIt: () => void = () => {};
    apiMocks.updateRole.mockImplementationOnce(() => new Promise<object>((r) => { resolveIt = () => r({}); }));
    const { container } = render(wrap(<RoleEditor teamId="t1" role={ROLE} onClose={vi.fn()} onSaved={vi.fn()} />));
    const saveBtn = [...container.querySelectorAll('button')].find((b) => /save/i.test(b.textContent ?? '')) as HTMLButtonElement;
    fireEvent.click(saveBtn);
    expect(saveBtn.disabled).toBe(true);
    resolveIt();
  });
});
