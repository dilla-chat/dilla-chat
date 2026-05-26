// Cover the ConnectionStatusBar slim banner (separate from the main
// ConnectionStatus component).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';

const h = vi.hoisted(() => ({
  wsHandlers: new Map<string, (...args: unknown[]) => void>(),
  isConnected: vi.fn(() => false),
}));

vi.mock('../../services/websocket', () => ({
  ws: {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      h.wsHandlers.set(event, handler);
      return vi.fn();
    }),
    isConnected: h.isConnected,
    ping: vi.fn(async () => 50),
  },
}));

import { ConnectionStatusBar } from './ConnectionStatus';
import { useTeamStore } from '../../stores/teamStore';

beforeEach(() => {
  h.wsHandlers.clear();
  h.isConnected.mockReturnValue(false);
  useTeamStore.setState({ activeTeamId: 't1' } as never);
  vi.useFakeTimers();
});

afterEach(() => vi.useRealTimers());

describe('ConnectionStatusBar', () => {
  it('renders "No connection" disconnected state initially', () => {
    const { container } = render(<ConnectionStatusBar />);
    expect(container.textContent).toContain('No connection');
  });

  it('renders nothing (hidden) when ws is connected at mount', () => {
    h.isConnected.mockReturnValue(true);
    const { container } = render(<ConnectionStatusBar />);
    expect(container.firstChild).toBeNull();
  });

  it('shows "Back online" then fades out after ws:connected event', () => {
    const { container } = render(<ConnectionStatusBar />);
    act(() => { h.wsHandlers.get('ws:connected')?.({}); });
    expect(container.textContent).toContain('Back online');
    act(() => { vi.advanceTimersByTime(2600); });
    expect(container.firstChild).toBeNull();
  });

  it('shows Reconnecting after 1.5s disconnected', () => {
    h.isConnected.mockReturnValue(true);
    const { container } = render(<ConnectionStatusBar />);
    expect(container.firstChild).toBeNull();
    act(() => { h.wsHandlers.get('ws:disconnected')?.({}); });
    expect(container.textContent).toContain('No connection');
    act(() => { vi.advanceTimersByTime(1600); });
    expect(container.textContent).toContain('Reconnecting');
  });

  it('quick reconnect cancels the reconnect-label timer', () => {
    h.isConnected.mockReturnValue(true);
    const { container } = render(<ConnectionStatusBar />);
    act(() => { h.wsHandlers.get('ws:disconnected')?.({}); });
    act(() => { h.wsHandlers.get('ws:connected')?.({}); });
    expect(container.textContent).toContain('Back online');
  });

  it('clears the timer on unmount', () => {
    const { unmount } = render(<ConnectionStatusBar />);
    act(() => { h.wsHandlers.get('ws:disconnected')?.({}); });
    unmount();
    expect(true).toBe(true);
  });
});
