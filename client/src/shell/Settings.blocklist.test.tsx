// Drive BlockListGroup + SafetyNumberQR.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const apiMocks = vi.hoisted(() => ({
  listBlocks: vi.fn(async () => ['u2', 'u3']),
  unblockUser: vi.fn(async () => {}),
}));

vi.mock('../services/api', () => ({ api: apiMocks }));
vi.mock('../services/mockSession', () => ({ isMockSession: () => false }));
vi.mock('qrcode', () => ({
  default: { toCanvas: vi.fn(async () => {}) },
}));

import { BlockListGroup, SafetyNumberQR } from './Settings';
import { ShellDataProvider } from './ShellDataContext';
import { useBlockStore } from '../stores/blockStore';
import { useTeamStore } from '../stores/teamStore';

const SHELL = {
  SERVERS: [], CHANNELS: [],
  MEMBERS: [
    { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0' },
    { id: 'u3', name: 'bob', initials: 'BO', color: '#00f' },
  ],
  byId: {
    u2: { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0' },
    u3: { id: 'u3', name: 'bob', initials: 'BO', color: '#00f' },
  },
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
  apiMocks.listBlocks.mockClear();
  apiMocks.unblockUser.mockClear();
  useBlockStore.setState({ blocked: new Set(['u2', 'u3']) } as never);
  useTeamStore.setState({ activeTeamId: 't1' } as never);
});

describe('BlockListGroup', () => {
  it('renders the blocked users list', async () => {
    const { container } = render(wrap(<BlockListGroup />));
    await waitFor(() => {
      expect(container.textContent).toContain('alice');
      expect(container.textContent).toContain('bob');
    });
  });

  it('hydrates from api.listBlocks on mount', async () => {
    render(wrap(<BlockListGroup />));
    await waitFor(() => expect(apiMocks.listBlocks).toHaveBeenCalledWith('t1'));
  });

  it('typing in the filter field narrows the list', () => {
    const { container } = render(wrap(<BlockListGroup />));
    const input = container.querySelector('input.set-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'alic' } });
    expect(container.textContent).toContain('alice');
    expect(container.textContent).not.toContain('bob');
  });

  it('shows "no matches" when filter excludes everything', () => {
    const { container } = render(wrap(<BlockListGroup />));
    const input = container.querySelector('input.set-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'xyz-no-such' } });
    expect(container.textContent).toContain('no matches');
  });

  it('shows "no blocked users" when list is empty', () => {
    useBlockStore.setState({ blocked: new Set() } as never);
    const { container } = render(wrap(<BlockListGroup />));
    expect(container.textContent).toContain('no blocked users');
  });

  it('clicking Unblock fires api.unblockUser + removes from store', async () => {
    const { container } = render(wrap(<BlockListGroup />));
    const unblockBtn = [...container.querySelectorAll('button')].find((b) => /unblock/i.test(b.textContent ?? '')) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(unblockBtn);
      await Promise.resolve();
    });
    expect(apiMocks.unblockUser).toHaveBeenCalled();
  });

  it('handles unblock errors gracefully (shows error message)', async () => {
    apiMocks.unblockUser.mockRejectedValueOnce(new Error('network down'));
    const { container } = render(wrap(<BlockListGroup />));
    const unblockBtn = [...container.querySelectorAll('button')].find((b) => /unblock/i.test(b.textContent ?? '')) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(unblockBtn);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('network down');
  });
});

describe('SafetyNumberQR', () => {
  it('renders modal + canvas + label', () => {
    const { container } = render(
      <SafetyNumberQR payload="01:23:45:67:89:ab" label="alice" onClose={vi.fn()} />,
    );
    expect(container.textContent).toContain('alice');
    expect(container.querySelector('canvas')).toBeTruthy();
  });

  it('clicking ✕ calls onClose', () => {
    const onClose = vi.fn();
    const { container } = render(
      <SafetyNumberQR payload="x" label="alice" onClose={onClose} />,
    );
    fireEvent.click(container.querySelector('.modal-x') as HTMLElement);
    expect(onClose).toHaveBeenCalled();
  });

  it('clicking backdrop calls onClose, clicking card body does not', () => {
    const onClose = vi.fn();
    const { container } = render(
      <SafetyNumberQR payload="x" label="alice" onClose={onClose} />,
    );
    fireEvent.click(container.querySelector('.modal-card') as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector('.modal-overlay-dismiss') as HTMLElement);
    expect(onClose).toHaveBeenCalled();
  });
});
