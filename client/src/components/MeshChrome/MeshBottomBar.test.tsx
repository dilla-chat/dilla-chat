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
  it('renders a contentinfo landmark with the mesh-bottom class', () => {
    const { container } = render(<MeshBottomBar />);
    expect(screen.getByRole('contentinfo', { name: /mesh bottom bar/i })).toBeInTheDocument();
    expect(container.querySelector('.mesh-bottom')).toBeInTheDocument();
  });

  it('shows node name', () => {
    useMeshStore.setState({ nodeName: 'gbg-1.dilla.local' });
    const { container } = render(<MeshBottomBar />);
    expect(container.textContent).toMatch(/gbg-1\.dilla\.local/i);
  });

  it('shows peers + lamport + latency when federated and not degraded', () => {
    useMeshStore.setState({
      status: 'ok',
      peersConnected: 2,
      peersTotal: 2,
      lamport: 12944,
      latencyMs: 14,
    });
    const { container } = render(<MeshBottomBar />);
    expect(container.textContent).toMatch(/peers/i);
    expect(container.textContent).toMatch(/2\/2/);
    expect(container.textContent).toMatch(/lamport 12,944/i);
    expect(container.textContent).toMatch(/latency 14ms p50/i);
  });

  it('shows warning indicator and dashes latency when degraded', () => {
    useMeshStore.setState({
      status: 'degraded',
      peersConnected: 1,
      peersTotal: 2,
    });
    const { container } = render(<MeshBottomBar />);
    expect(container.textContent).toMatch(/1\/2 ⚠/);
    expect(container.textContent).toMatch(/latency —/i);
  });

  it('hides federation chunks (peers/lamport/latency) when status is ready', () => {
    useMeshStore.setState({ status: 'ready' });
    const { container } = render(<MeshBottomBar />);
    expect(container.textContent).not.toMatch(/peers/i);
    expect(container.textContent).not.toMatch(/lamport/i);
  });

  it('clicking the e2e chunk dispatches mesh:open-privacy', () => {
    const spy = vi.spyOn(window, 'dispatchEvent');
    render(<MeshBottomBar />);
    fireEvent.click(screen.getByTitle(/encryption/i));
    expect(
      spy.mock.calls.some(
        (call) =>
          call[0] instanceof CustomEvent && call[0].type === 'mesh:open-privacy',
      ),
    ).toBe(true);
    spy.mockRestore();
  });

  it('shows the db chunk when voice is not connected', () => {
    const { container } = render(<MeshBottomBar />);
    expect(container.textContent).toMatch(/db SQLCIPHER/i);
  });

  it('shows version + build in the rightmost chunk', () => {
    const { container } = render(<MeshBottomBar />);
    expect(container.textContent).toMatch(/v 0\.4\.2-nightly/i);
    expect(container.textContent).toMatch(/build c0ffee/i);
  });
});
