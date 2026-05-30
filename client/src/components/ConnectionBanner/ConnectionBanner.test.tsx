import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ConnectionBanner from './ConnectionBanner';
import { useMeshStore } from '../../stores/meshStore';

beforeEach(() => {
  useMeshStore.setState({ connectionBanner: null });
});

describe('ConnectionBanner', () => {
  it('renders nothing when no banner state', () => {
    const { container } = render(<ConnectionBanner />);
    expect(container.querySelector('.connection-banner')).not.toBeInTheDocument();
  });

  it('renders reconnecting banner with label + message', () => {
    useMeshStore.setState({
      connectionBanner: { kind: 'reconnecting', message: 'Reconnecting to mesh…' },
    });
    render(<ConnectionBanner />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('RECONNECTING')).toBeInTheDocument();
    expect(screen.getByText(/reconnecting to mesh/i)).toBeInTheDocument();
  });

  it('renders offline banner', () => {
    useMeshStore.setState({
      connectionBanner: { kind: 'offline', message: 'No connection' },
    });
    render(<ConnectionBanner />);
    expect(screen.getByText('OFFLINE')).toBeInTheDocument();
  });

  it('dismiss button clears state', () => {
    useMeshStore.setState({
      connectionBanner: { kind: 'restored', message: 'Back online' },
    });
    render(<ConnectionBanner />);
    fireEvent.click(screen.getByLabelText(/dismiss/i));
    expect(useMeshStore.getState().connectionBanner).toBeNull();
  });
});
