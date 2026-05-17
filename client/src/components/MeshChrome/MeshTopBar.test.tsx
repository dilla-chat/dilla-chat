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
  it('renders the brand mark, banner role, and three keybind buttons', () => {
    const { container } = render(<MeshTopBar />);
    expect(screen.getByRole('banner', { name: /mesh top bar/i })).toBeInTheDocument();
    expect(container.querySelector('.mesh-top')).toBeInTheDocument();
    expect(screen.getByText('DILLA')).toBeInTheDocument();
    expect(container.querySelectorAll('.mt-key').length).toBe(3);
  });

  it('shows HH:MM:SS clock', () => {
    render(<MeshTopBar />);
    const center = screen.getByLabelText(/current time/i);
    expect(center.textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('shows READY when meshStore.status is ready', () => {
    useMeshStore.setState({ status: 'ready' });
    render(<MeshTopBar />);
    expect(screen.getByText(/READY/i)).toBeInTheDocument();
  });

  it('shows MESH OK when status is ok', () => {
    useMeshStore.setState({ status: 'ok' });
    render(<MeshTopBar />);
    expect(screen.getByText(/MESH OK/i)).toBeInTheDocument();
  });

  it('shows MESH DEGRADED when status is degraded', () => {
    useMeshStore.setState({ status: 'degraded' });
    render(<MeshTopBar />);
    expect(screen.getByText(/MESH DEGRADED/i)).toBeInTheDocument();
  });

  it('uses the short node name (first dotted segment)', () => {
    useMeshStore.setState({ nodeName: 'gbg-1.dilla.local' });
    render(<MeshTopBar />);
    expect(screen.getByText('gbg-1')).toBeInTheDocument();
  });
});
