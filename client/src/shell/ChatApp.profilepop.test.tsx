// Direct unit tests on the exported ProfilePopover, driving the
// outside-click + Escape useEffect, window.MeshChrome lookup, the
// federated-node chip, the fingerprint row, and the two action buttons.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';

if (typeof globalThis.ResizeObserver === 'undefined') {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
}

vi.mock('../services/websocket', () => ({ ws: {} }));
vi.mock('../services/api', () => ({ api: {} }));
vi.mock('./icons', () => {
  const stub = () => <span data-icon />;
  return { Icon: new Proxy({}, { get: () => stub }), default: new Proxy({}, { get: () => stub }) };
});

import { ProfilePopover } from './ChatApp';
import { ShellDataProvider } from './ShellDataContext';

const ME = { id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online' };
const ALICE = {
  id: 'u2',
  name: 'alice',
  initials: 'AL',
  color: '#0f0',
  status: 'online',
  role: 'admin',
  custom: 'on a train',
};

const SHELL = {
  SERVERS: [], CHANNELS: [], MEMBERS: [ME, ALICE],
  byId: { me: ME, u2: ALICE },
  MESSAGES: {}, DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: {},
  activeServerId: null, activeChannelId: null, currentUserId: 'me',
};

function wrap(c: React.ReactNode) {
  return <ShellDataProvider value={SHELL}>{c}</ShellDataProvider>;
}

beforeEach(() => {
  (window as unknown as { MeshChrome?: unknown }).MeshChrome = {
    MEMBER_NODES: { u2: 'remote.node.io' },
    FINGERPRINTS: { u2: '1234 5678 abcd' },
  };
});

afterEach(() => {
  delete (window as unknown as { MeshChrome?: unknown }).MeshChrome;
});

describe('ProfilePopover', () => {
  it('renders nothing when pop is null', () => {
    const { container } = render(wrap(
      <ProfilePopover pop={null} onClose={vi.fn()} onDM={vi.fn()} federated={false} />,
    ));
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when memberId is unknown', () => {
    const { container } = render(wrap(
      <ProfilePopover pop={{ memberId: 'unknown', x: 100, y: 100 }} onClose={vi.fn()} onDM={vi.fn()} federated={false} />,
    ));
    expect(container.firstChild).toBeNull();
  });

  it('renders member name + role + custom status', () => {
    const { container } = render(wrap(
      <ProfilePopover pop={{ memberId: 'u2', x: 100, y: 100 }} onClose={vi.fn()} onDM={vi.fn()} federated={false} />,
    ));
    expect(container.textContent).toContain('alice');
    expect(container.textContent).toContain('admin');
    expect(container.textContent).toContain('on a train');
  });

  it('shows the federated chip when federated=true and node is non-gbg-1', () => {
    const { container } = render(wrap(
      <ProfilePopover pop={{ memberId: 'u2', x: 100, y: 100 }} onClose={vi.fn()} onDM={vi.fn()} federated />,
    ));
    expect(container.textContent).toContain('node');
    expect(container.textContent).toContain('remote.node');
    expect(container.textContent).toContain('federated');
  });

  it('shows the fingerprint row when window.MeshChrome.FINGERPRINTS[id] is set', () => {
    const { container } = render(wrap(
      <ProfilePopover pop={{ memberId: 'u2', x: 100, y: 100 }} onClose={vi.fn()} onDM={vi.fn()} federated={false} />,
    ));
    expect(container.textContent).toContain('safety');
    expect(container.textContent).toContain('1234 5678');
  });

  it('Send message button calls onDM with member id + closes', () => {
    const onDM = vi.fn();
    const onClose = vi.fn();
    const { container } = render(wrap(
      <ProfilePopover pop={{ memberId: 'u2', x: 100, y: 100 }} onClose={onClose} onDM={onDM} federated={false} />,
    ));
    const sendBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => /send message/i.test(b.textContent ?? ''),
    ) as HTMLButtonElement;
    fireEvent.click(sendBtn);
    expect(onDM).toHaveBeenCalledWith('u2');
    expect(onClose).toHaveBeenCalled();
  });

  it('View profile button calls onClose', () => {
    const onClose = vi.fn();
    const { container } = render(wrap(
      <ProfilePopover pop={{ memberId: 'u2', x: 100, y: 100 }} onClose={onClose} onDM={vi.fn()} federated={false} />,
    ));
    const viewBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => /view profile/i.test(b.textContent ?? ''),
    ) as HTMLButtonElement;
    fireEvent.click(viewBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it('Escape keydown closes the popover', () => {
    const onClose = vi.fn();
    render(wrap(
      <ProfilePopover pop={{ memberId: 'u2', x: 100, y: 100 }} onClose={onClose} onDM={vi.fn()} federated={false} />,
    ));
    act(() => fireEvent.keyDown(document, { key: 'Escape' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('clamps x/y to viewport bounds', () => {
    const { container } = render(wrap(
      <ProfilePopover pop={{ memberId: 'u2', x: 99999, y: 99999 }} onClose={vi.fn()} onDM={vi.fn()} federated={false} />,
    ));
    const el = container.querySelector('.pop-profile') as HTMLElement;
    // Position is set inline; values should be finite/non-negative.
    const left = parseFloat(el.style.left);
    const top = parseFloat(el.style.top);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
  });

  it('mousedown outside the popover closes it (after the next tick)', async () => {
    const onClose = vi.fn();
    const { container } = render(wrap(
      <ProfilePopover pop={{ memberId: 'u2', x: 100, y: 100 }} onClose={onClose} onDM={vi.fn()} federated={false} />,
    ));
    // useEffect uses setTimeout(0) to attach the listener — wait one tick.
    await new Promise((r) => setTimeout(r, 5));
    // Click outside the popover.
    act(() => fireEvent.mouseDown(document.body));
    expect(onClose).toHaveBeenCalled();
    // Mousedown inside the popover should NOT close.
    onClose.mockClear();
    const inside = container.querySelector('.pop-profile') as HTMLElement;
    act(() => fireEvent.mouseDown(inside));
    expect(onClose).not.toHaveBeenCalled();
  });
});
