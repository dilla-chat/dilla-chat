import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ConnectionStatus from './ConnectionStatus';
import { useTeamStore } from '../../stores/teamStore';

vi.mock('../../services/websocket', () => ({
  ws: {
    isConnected: vi.fn(() => false),
    on: vi.fn(() => vi.fn()),
    ping: vi.fn(() => Promise.resolve(50)),
  },
}));

describe('ConnectionStatus', () => {
  beforeEach(() => {
    useTeamStore.setState({ activeTeamId: 'team-1' });
  });

  it('renders the connection status bars', () => {
    render(<ConnectionStatus />);
    expect(screen.getByTestId('connection-status')).toBeInTheDocument();
    expect(screen.getAllByTestId('connection-bar').length).toBeGreaterThan(0);
  });

  it('renders 4 bar elements', () => {
    render(<ConnectionStatus />);
    const bars = screen.getAllByTestId('connection-bar');
    expect(bars).toHaveLength(4);
  });

  it('shows disconnected state initially when ws is not connected', () => {
    render(<ConnectionStatus />);
    const statusEl = screen.getByTestId('connection-status');
    expect(statusEl).toHaveAttribute('data-quality', 'disconnected');
  });

  it('shows no active bars when disconnected', () => {
    render(<ConnectionStatus />);
    const bars = screen.getAllByTestId('connection-bar');
    const activeBars = bars.filter((b) => b.getAttribute('data-active') === 'true');
    expect(activeBars).toHaveLength(0);
  });

  it('shows tooltip on mouse enter', () => {
    render(<ConnectionStatus />);
    const statusEl = screen.getByTestId('connection-status');
    fireEvent.mouseEnter(statusEl);
    expect(screen.getByText('Connection Info')).toBeInTheDocument();
    expect(screen.getByText('Quality')).toBeInTheDocument();
    expect(screen.getByText('Latency')).toBeInTheDocument();
    expect(screen.getByText('WebSocket')).toBeInTheDocument();
  });

  it('hides tooltip on mouse leave', () => {
    render(<ConnectionStatus />);
    const statusEl = screen.getByTestId('connection-status');
    fireEvent.mouseEnter(statusEl);
    expect(screen.getByText('Connection Info')).toBeInTheDocument();
    fireEvent.mouseLeave(statusEl);
    expect(screen.queryByText('Connection Info')).not.toBeInTheDocument();
  });

  it('shows Disconnected in tooltip when disconnected', () => {
    render(<ConnectionStatus />);
    const statusEl = screen.getByTestId('connection-status');
    fireEvent.mouseEnter(statusEl);
    // Both quality badge and WebSocket row show 'Disconnected'
    const elements = screen.getAllByText('Disconnected');
    expect(elements.length).toBeGreaterThanOrEqual(1);
  });

  it('shows dash for latency when no latency data', () => {
    render(<ConnectionStatus />);
    const statusEl = screen.getByTestId('connection-status');
    fireEvent.mouseEnter(statusEl);
    // The em-dash character for null latency
    const latencyRow = screen.getByTestId('tooltip-latency');
    expect(latencyRow.textContent).toContain('\u2014');
  });

  it('shows connected state and latency after successful ping', async () => {
    const { ws } = await import('../../services/websocket');
    vi.mocked(ws.isConnected).mockReturnValue(true);
    vi.mocked(ws.ping).mockResolvedValue(50);

    render(<ConnectionStatus />);

    await vi.waitFor(() => {
      // Should transition from disconnected to a connected state
      const el = screen.getByTestId('connection-status');
      expect(el.getAttribute('data-quality')).not.toBe('disconnected');
    });

    const statusEl = screen.getByTestId('connection-status');
    fireEvent.mouseEnter(statusEl);
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('50 ms')).toBeInTheDocument();
  });

  it('shows excellent quality for low latency', async () => {
    const { ws } = await import('../../services/websocket');
    vi.mocked(ws.isConnected).mockReturnValue(true);
    vi.mocked(ws.ping).mockResolvedValue(30);

    render(<ConnectionStatus />);

    await vi.waitFor(() => {
      expect(screen.getByTestId('connection-status')).toHaveAttribute('data-quality', 'excellent');
    });

    fireEvent.mouseEnter(screen.getByTestId('connection-status'));
    expect(screen.getByText('Excellent')).toBeInTheDocument();
  });

  it('shows good quality for moderate latency', async () => {
    const { ws } = await import('../../services/websocket');
    vi.mocked(ws.isConnected).mockReturnValue(true);
    vi.mocked(ws.ping).mockResolvedValue(150);

    render(<ConnectionStatus />);

    await vi.waitFor(() => {
      expect(screen.getByTestId('connection-status')).toHaveAttribute('data-quality', 'good');
    });
  });

  it('shows poor quality for high latency', async () => {
    const { ws } = await import('../../services/websocket');
    vi.mocked(ws.isConnected).mockReturnValue(true);
    vi.mocked(ws.ping).mockResolvedValue(300);

    render(<ConnectionStatus />);

    await vi.waitFor(() => {
      expect(screen.getByTestId('connection-status')).toHaveAttribute('data-quality', 'poor');
    });
  });

  it('handles ping failure gracefully', async () => {
    const { ws } = await import('../../services/websocket');
    vi.mocked(ws.isConnected).mockReturnValue(true);
    vi.mocked(ws.ping).mockRejectedValue(new Error('timeout'));

    render(<ConnectionStatus />);

    // Should not crash
    await vi.waitFor(() => {
      expect(screen.getByTestId('connection-status')).toBeInTheDocument();
    });
  });

  it('shows correct number of active bars for excellent quality', async () => {
    const { ws } = await import('../../services/websocket');
    vi.mocked(ws.isConnected).mockReturnValue(true);
    vi.mocked(ws.ping).mockResolvedValue(30);

    render(<ConnectionStatus />);

    await vi.waitFor(() => {
      const bars = screen.getAllByTestId('connection-bar');
      const activeBars = bars.filter((b) => b.getAttribute('data-active') === 'true');
      expect(activeBars).toHaveLength(4);
    });
  });

  it('updates state on ws:connected event', async () => {
    const { ws } = await import('../../services/websocket');
    let connectedHandler: (...args: unknown[]) => void = () => {};
    vi.mocked(ws.on).mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'ws:connected') connectedHandler = handler;
      return vi.fn();
    });

    render(<ConnectionStatus />);
    // Trigger the connected handler
    connectedHandler();

    await vi.waitFor(() => {
      const statusEl = screen.getByTestId('connection-status');
      fireEvent.mouseEnter(statusEl);
      expect(screen.getByText('Connected')).toBeInTheDocument();
    });
  });

  it('updates state on ws:disconnected event', async () => {
    const { ws } = await import('../../services/websocket');
    let disconnectedHandler: (...args: unknown[]) => void = () => {};
    vi.mocked(ws.on).mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'ws:disconnected') disconnectedHandler = handler;
      return vi.fn();
    });

    // Start connected
    vi.mocked(ws.isConnected).mockReturnValue(true);
    vi.mocked(ws.ping).mockResolvedValue(50);

    render(<ConnectionStatus />);

    await vi.waitFor(() => {
      expect(screen.getByTestId('connection-status')).toHaveAttribute('data-quality', 'excellent');
    });

    // Trigger disconnected
    disconnectedHandler();

    await vi.waitFor(() => {
      expect(screen.getByTestId('connection-status')).toHaveAttribute('data-quality', 'disconnected');
    });
  });

  it('shows poor state when ping fails but ws is still connected', async () => {
    const { ws } = await import('../../services/websocket');
    vi.mocked(ws.isConnected).mockReturnValue(true);
    vi.mocked(ws.ping).mockRejectedValue(new Error('timeout'));

    render(<ConnectionStatus />);

    await vi.waitFor(() => {
      // Should show poor quality since ping failed but ws is connected
      const statusEl = screen.getByTestId('connection-status');
      fireEvent.mouseEnter(statusEl);
      expect(screen.getByText('Poor')).toBeInTheDocument();
    });
  });

  it('shows disconnected when ws not connected and no activeTeamId for ping', async () => {
    const { ws } = await import('../../services/websocket');
    vi.mocked(ws.isConnected).mockReturnValue(false);
    useTeamStore.setState({ activeTeamId: 'team-1' });

    render(<ConnectionStatus />);

    await vi.waitFor(() => {
      expect(screen.getByTestId('connection-status')).toHaveAttribute('data-quality', 'disconnected');
    });
  });

  it('renders without errors when no team is active', () => {
    useTeamStore.setState({ activeTeamId: null });
    render(<ConnectionStatus />);
    expect(screen.getByTestId('connection-status')).toBeInTheDocument();
  });

  it('pingServer sets disconnected when isConnected returns false with active team', async () => {
    const { ws } = await import('../../services/websocket');
    vi.useFakeTimers();
    // isConnected returns false -> triggers lines 55-56 in pingServer
    vi.mocked(ws.isConnected).mockReturnValue(false);
    useTeamStore.setState({ activeTeamId: 'team-1' });

    render(<ConnectionStatus />);

    // Flush the setTimeout(pingServer, 0)
    await vi.advanceTimersByTimeAsync(10);

    const statusEl = screen.getByTestId('connection-status');
    fireEvent.mouseEnter(statusEl);
    const disconnectedEls = screen.getAllByText('Disconnected');
    expect(disconnectedEls.length).toBeGreaterThanOrEqual(1);

    vi.useRealTimers();
  });
});
