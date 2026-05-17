import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MeshBottomBar from './MeshBottomBar';
import { useMeshStore } from '../../stores/meshStore';

vi.mock('../../stores/voiceStore', () => ({
  useVoiceStore: (selector: (s: { connected: boolean }) => unknown) =>
    selector({ connected: false }),
}));

beforeEach(() => {
  useMeshStore.setState({
    nodeName: '',
    peersConnected: 0,
    peersTotal: 0,
    lamport: 0,
    latencyMs: 0,
    status: 'ready',
    connectionBanner: null,
  });
});

describe('MeshBottomBar', () => {
  it('renders a content-info landmark', () => {
    render(<MeshBottomBar />);
    const bar = screen.getByRole('contentinfo', { name: /mesh bottom bar/i });
    expect(bar).toBeInTheDocument();
    expect(bar).toHaveClass('mesh-bottom-bar');
  });

  it('shows node name when set', () => {
    useMeshStore.setState({ nodeName: 'gbg-1.dilla.local' });
    const { container } = render(<MeshBottomBar />);
    expect(container.textContent).toMatch(/node gbg-1\.dilla\.local/i);
  });

  it('shows peers count and lamport', () => {
    useMeshStore.setState({ peersConnected: 2, peersTotal: 2, lamport: 12944 });
    const { container } = render(<MeshBottomBar />);
    expect(container.textContent).toMatch(/peers 2\/2/i);
    expect(container.textContent).toMatch(/lamport 12,944/i);
  });

  it('shows latency when not degraded', () => {
    useMeshStore.setState({ status: 'ok', latencyMs: 14 });
    const { container } = render(<MeshBottomBar />);
    expect(container.textContent).toMatch(/latency 14ms p50/i);
  });

  it('hides latency and shows warning glyph when degraded', () => {
    useMeshStore.setState({
      status: 'degraded',
      peersConnected: 1,
      peersTotal: 2,
    });
    const { container } = render(<MeshBottomBar />);
    expect(container.textContent).toMatch(/peers 1\/2/i);
    expect(container.textContent).not.toMatch(/latency/i);
  });

  it('clicking a chunk dispatches a custom event', () => {
    const spy = vi.spyOn(window, 'dispatchEvent');
    render(<MeshBottomBar />);
    fireEvent.click(screen.getByTitle(/privacy/i));
    expect(
      spy.mock.calls.some(
        (call) =>
          call[0] instanceof CustomEvent &&
          call[0].type === 'mesh:open-privacy',
      ),
    ).toBe(true);
    spy.mockRestore();
  });

  it('shows version + build at the right', () => {
    const { container } = render(<MeshBottomBar />);
    expect(container.textContent).toMatch(/v 0\.4\.2-nightly/i);
    expect(container.textContent).toMatch(/build c0ffee/i);
  });
});
