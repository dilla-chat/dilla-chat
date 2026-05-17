import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import MeshTopBar from './MeshTopBar';
import { useMeshStore } from '../../stores/meshStore';

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

describe('MeshTopBar', () => {
  it('renders a top-bar landmark with brand mark', () => {
    render(<MeshTopBar />);
    const bar = screen.getByRole('banner', { name: /mesh top bar/i });
    expect(bar).toBeInTheDocument();
    expect(bar).toHaveClass('mesh-top-bar');
    expect(screen.getByText(/dilla/i)).toBeInTheDocument();
  });

  it('shows live HH:MM:SS clock', () => {
    render(<MeshTopBar />);
    const clock = screen.getByLabelText(/current time/i);
    expect(clock.textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('shows MESH OK status when meshStore.status is ok', () => {
    useMeshStore.setState({ status: 'ok' });
    render(<MeshTopBar />);
    expect(screen.getByText(/MESH OK/i)).toBeInTheDocument();
  });

  it('shows MESH DEGRADED status when meshStore.status is degraded', () => {
    useMeshStore.setState({ status: 'degraded' });
    render(<MeshTopBar />);
    expect(screen.getByText(/MESH DEGRADED/i)).toBeInTheDocument();
  });

  it('shows node name when present', () => {
    useMeshStore.setState({ nodeName: 'gbg-1.dilla.local', status: 'ok' });
    render(<MeshTopBar />);
    expect(screen.getByText(/gbg-1\.dilla\.local/i)).toBeInTheDocument();
  });

  it('renders keybind hints (⌘K, /, ?)', () => {
    render(<MeshTopBar />);
    expect(screen.getByTitle(/command palette/i)).toBeInTheDocument();
    expect(screen.getByTitle(/search/i)).toBeInTheDocument();
    expect(screen.getByTitle(/hide top bar/i)).toBeInTheDocument();
  });
});
