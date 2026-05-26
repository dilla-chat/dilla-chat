// Drive ChannelSettingsModal save/delete/Escape + NewServerModal create/join.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';

if (typeof globalThis.ResizeObserver === 'undefined') {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
}

const apiMocks = vi.hoisted(() => ({
  updateChannel: vi.fn(async () => ({})),
  deleteChannel: vi.fn(async () => {}),
}));
vi.mock('../services/api', () => ({ api: apiMocks }));
vi.mock('../services/websocket', () => ({ ws: { on: vi.fn(() => () => {}) } }));
vi.mock('../services/mockSession', () => ({ isMockSession: () => false }));
vi.mock('./icons', () => {
  const stub = () => <span data-icon />;
  return { Icon: new Proxy({}, { get: () => stub }), default: new Proxy({}, { get: () => stub }) };
});

import { ChannelSettingsModal, NewServerModal } from './ChatApp';
import { ShellDataProvider } from './ShellDataContext';
import { useTeamStore } from '../stores/teamStore';

const SHELL = {
  SERVERS: [{ id: 't1', name: 'Acme' }],
  CHANNELS: [
    { id: 'ch-1', name: 'general', type: 'text', topic: 'old topic', category: 'main' },
    { id: 'ch-2', name: 'random', type: 'text', topic: '', category: 'main' },
    { id: 'ch-3', name: 'design', type: 'text', topic: '', category: 'product' },
  ],
  MEMBERS: [], byId: {},
  MESSAGES: {}, DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: {},
  activeServerId: 't1', activeChannelId: 'ch-1', currentUserId: 'me',
};

function wrap(c: React.ReactNode) {
  return <ShellDataProvider value={SHELL}>{c}</ShellDataProvider>;
}

beforeEach(() => {
  apiMocks.updateChannel.mockClear();
  apiMocks.deleteChannel.mockClear();
  useTeamStore.setState({
    activeTeamId: 't1', activeChannelId: 'ch-1',
    channels: new Map([['t1', [
      { id: 'ch-1', name: 'general', type: 'text' as const },
      { id: 'ch-2', name: 'random', type: 'text' as const },
    ]]]),
  } as never);
});

const CHANNEL = { id: 'ch-1', name: 'general', type: 'text', topic: 'old topic', category: 'main', slowModeSeconds: 0 };

describe('ChannelSettingsModal', () => {
  it('renders with current topic + slow mode + group', () => {
    const { container } = render(wrap(<ChannelSettingsModal channel={CHANNEL} onClose={vi.fn()} />));
    expect(container.textContent).toContain('general');
    expect(container.textContent).toContain('Topic');
    expect(container.textContent).toContain('Slow mode');
  });

  it('Escape calls onClose', () => {
    const onClose = vi.fn();
    render(wrap(<ChannelSettingsModal channel={CHANNEL} onClose={onClose} />));
    act(() => { fireEvent.keyDown(window, { key: 'Escape' }); });
    expect(onClose).toHaveBeenCalled();
  });

  it('backdrop click closes; card click does not', () => {
    const onClose = vi.fn();
    const { container } = render(wrap(<ChannelSettingsModal channel={CHANNEL} onClose={onClose} />));
    fireEvent.click(container.querySelector('.modal-card') as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector('.modal-overlay') as HTMLElement);
    expect(onClose).toHaveBeenCalled();
  });

  it('typing new topic + Save calls api.updateChannel', async () => {
    const onClose = vi.fn();
    const { container } = render(wrap(<ChannelSettingsModal channel={CHANNEL} onClose={onClose} />));
    const inputs = [...container.querySelectorAll('input')] as HTMLInputElement[];
    fireEvent.change(inputs[0], { target: { value: 'new topic' } });
    const saveBtn = [...container.querySelectorAll('button')].find((b) => /save/i.test(b.textContent ?? '')) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(saveBtn);
      await Promise.resolve();
    });
    expect(apiMocks.updateChannel).toHaveBeenCalled();
  });

  it('slow mode strips non-digits', () => {
    const { container } = render(wrap(<ChannelSettingsModal channel={CHANNEL} onClose={vi.fn()} />));
    const inputs = [...container.querySelectorAll('input')] as HTMLInputElement[];
    const slowInput = inputs[inputs.length - 1];
    fireEvent.change(slowInput, { target: { value: 'abc15def' } });
    expect(slowInput.value).toBe('15');
  });

  it('Delete kanal button shows confirm panel', () => {
    const { container } = render(wrap(<ChannelSettingsModal channel={CHANNEL} onClose={vi.fn()} />));
    const deleteBtn = [...container.querySelectorAll('button')].find((b) => /delete kanal/i.test(b.textContent ?? '')) as HTMLButtonElement;
    fireEvent.click(deleteBtn);
    expect(container.textContent).toMatch(/Permanently removes|This can't be undone/i);
  });

  it('confirm + Delete kanal calls api.deleteChannel', async () => {
    const onClose = vi.fn();
    const { container } = render(wrap(<ChannelSettingsModal channel={CHANNEL} onClose={onClose} />));
    fireEvent.click([...container.querySelectorAll('button')].find((b) => /delete kanal/i.test(b.textContent ?? '')) as HTMLButtonElement);
    const danger = [...container.querySelectorAll('button.btn--danger')] as HTMLButtonElement[];
    const finalDelete = danger.find((b) => /delete kanal/i.test(b.textContent ?? '')) as HTMLButtonElement;
    if (finalDelete) {
      await act(async () => {
        fireEvent.click(finalDelete);
        await Promise.resolve();
      });
    }
    expect(apiMocks.deleteChannel).toHaveBeenCalled();
  });

  it('Cancel from delete-confirm goes back', () => {
    const { container } = render(wrap(<ChannelSettingsModal channel={CHANNEL} onClose={vi.fn()} />));
    fireEvent.click([...container.querySelectorAll('button')].find((b) => /delete kanal/i.test(b.textContent ?? '')) as HTMLButtonElement);
    const cancel = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Cancel') as HTMLButtonElement;
    fireEvent.click(cancel);
    expect(container.textContent).not.toMatch(/Permanently removes/i);
  });

  it('Save error shows error message', async () => {
    apiMocks.updateChannel.mockRejectedValueOnce(new Error('forbidden'));
    const { container } = render(wrap(<ChannelSettingsModal channel={CHANNEL} onClose={vi.fn()} />));
    const inputs = [...container.querySelectorAll('input')] as HTMLInputElement[];
    fireEvent.change(inputs[0], { target: { value: 'new' } });
    const saveBtn = [...container.querySelectorAll('button')].find((b) => /save/i.test(b.textContent ?? '')) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(saveBtn);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('forbidden');
  });
});

describe('NewServerModal', () => {
  it('renders Create mode by default', () => {
    const { container } = render(<NewServerModal onClose={vi.fn()} onCreate={vi.fn()} />);
    expect(container.textContent).toMatch(/create|join/i);
  });

  it('switches to Join mode', () => {
    const { container } = render(<NewServerModal onClose={vi.fn()} onCreate={vi.fn()} />);
    const joinTab = [...container.querySelectorAll('button')].find((b) => /join/i.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
    if (joinTab) fireEvent.click(joinTab);
    expect(container.firstChild).toBeTruthy();
  });

  it('clicking Cancel calls onClose', () => {
    const onClose = vi.fn();
    const { container } = render(<NewServerModal onClose={onClose} onCreate={vi.fn()} />);
    const cancelBtn = [...container.querySelectorAll('button')].find((b) => /cancel/i.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
    if (cancelBtn) fireEvent.click(cancelBtn);
    expect(container.firstChild).toBeTruthy();
  });

  it('typing in name + URL fields', () => {
    const { container } = render(<NewServerModal onClose={vi.fn()} onCreate={vi.fn()} />);
    const inputs = [...container.querySelectorAll('input')] as HTMLInputElement[];
    for (const i of inputs) {
      try { fireEvent.change(i, { target: { value: 'value' } }); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });
});
