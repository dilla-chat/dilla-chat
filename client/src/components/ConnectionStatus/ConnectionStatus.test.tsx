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
    const { container } = render(<ConnectionStatus />);
    expect(container.querySelector('.connection-status')).toBeInTheDocument();
    expect(container.querySelector('.connection-status__bars')).toBeInTheDocument();
  });

  it('renders 4 bar elements', () => {
    const { container } = render(<ConnectionStatus />);
    const bars = container.querySelectorAll('.connection-status__bar');
    expect(bars).toHaveLength(4);
  });

  it('shows disconnected state initially when ws is not connected', () => {
    const { container } = render(<ConnectionStatus />);
    expect(container.querySelector('.connection-status--disconnected')).toBeInTheDocument();
  });

  it('shows no active bars when disconnected', () => {
    const { container } = render(<ConnectionStatus />);
    const activeBars = container.querySelectorAll('.connection-status__bar.active');
    expect(activeBars).toHaveLength(0);
  });

  it('shows tooltip on mouse enter', () => {
    const { container } = render(<ConnectionStatus />);
    const statusEl = container.querySelector('.connection-status')!;
    fireEvent.mouseEnter(statusEl);
    expect(screen.getByText('Connection Info')).toBeInTheDocument();
    expect(screen.getByText('Quality')).toBeInTheDocument();
    expect(screen.getByText('Latency')).toBeInTheDocument();
    expect(screen.getByText('WebSocket')).toBeInTheDocument();
  });

  it('hides tooltip on mouse leave', () => {
    const { container } = render(<ConnectionStatus />);
    const statusEl = container.querySelector('.connection-status')!;
    fireEvent.mouseEnter(statusEl);
    expect(screen.getByText('Connection Info')).toBeInTheDocument();
    fireEvent.mouseLeave(statusEl);
    expect(screen.queryByText('Connection Info')).not.toBeInTheDocument();
  });

  it('shows Disconnected in tooltip when disconnected', () => {
    const { container } = render(<ConnectionStatus />);
    const statusEl = container.querySelector('.connection-status')!;
    fireEvent.mouseEnter(statusEl);
    // Both quality badge and WebSocket row show 'Disconnected'
    const elements = screen.getAllByText('Disconnected');
    expect(elements.length).toBeGreaterThanOrEqual(1);
  });

  it('shows dash for latency when no latency data', () => {
    const { container } = render(<ConnectionStatus />);
    const statusEl = container.querySelector('.connection-status')!;
    fireEvent.mouseEnter(statusEl);
    // The em-dash character for null latency
    const rows = container.querySelectorAll('.connection-status__tooltip-row');
    // Latency row is the second row
    const latencyRow = rows[1];
    expect(latencyRow.textContent).toContain('\u2014');
  });

  it('shows connected state and latency after successful ping', async () => {
    const { ws } = await import('../../services/websocket');
    (ws.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (ws.ping as ReturnType<typeof vi.fn>).mockResolvedValue(50);

    const { container } = render(<ConnectionStatus />);

    await vi.waitFor(() => {
      // Should transition from disconnected to a connected state
      const el = container.querySelector('.connection-status');
      expect(el?.className).not.toContain('disconnected');
    });

    const statusEl = container.querySelector('.connection-status')!;
    fireEvent.mouseEnter(statusEl);
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('50 ms')).toBeInTheDocument();
  });

  it('shows excellent quality for low latency', async () => {
    const { ws } = await import('../../services/websocket');
    (ws.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (ws.ping as ReturnType<typeof vi.fn>).mockResolvedValue(30);

    const { container } = render(<ConnectionStatus />);

    await vi.waitFor(() => {
      expect(container.querySelector('.connection-status--excellent')).toBeInTheDocument();
    });

    fireEvent.mouseEnter(container.querySelector('.connection-status')!);
    expect(screen.getByText('Excellent')).toBeInTheDocument();
  });

  it('shows good quality for moderate latency', async () => {
    const { ws } = await import('../../services/websocket');
    (ws.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (ws.ping as ReturnType<typeof vi.fn>).mockResolvedValue(150);

    const { container } = render(<ConnectionStatus />);

    await vi.waitFor(() => {
      expect(container.querySelector('.connection-status--good')).toBeInTheDocument();
    });
  });

  it('shows poor quality for high latency', async () => {
    const { ws } = await import('../../services/websocket');
    (ws.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (ws.ping as ReturnType<typeof vi.fn>).mockResolvedValue(300);

    const { container } = render(<ConnectionStatus />);

    await vi.waitFor(() => {
      expect(container.querySelector('.connection-status--poor')).toBeInTheDocument();
    });
  });

  it('handles ping failure gracefully', async () => {
    const { ws } = await import('../../services/websocket');
    (ws.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (ws.ping as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('timeout'));

    const { container } = render(<ConnectionStatus />);

    // Should not crash
    await vi.waitFor(() => {
      expect(container.querySelector('.connection-status')).toBeInTheDocument();
    });
  });

  it('shows correct number of active bars for excellent quality', async () => {
    const { ws } = await import('../../services/websocket');
    (ws.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (ws.ping as ReturnType<typeof vi.fn>).mockResolvedValue(30);

    const { container } = render(<ConnectionStatus />);

    await vi.waitFor(() => {
      const activeBars = container.querySelectorAll('.connection-status__bar.active');
      expect(activeBars).toHaveLength(4);
    });
  });

  it('renders without errors when no team is active', () => {
    useTeamStore.setState({ activeTeamId: null });
    const { container } = render(<ConnectionStatus />);
    expect(container.querySelector('.connection-status')).toBeInTheDocument();
  });
});
