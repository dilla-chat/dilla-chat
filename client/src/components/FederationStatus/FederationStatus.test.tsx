import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import FederationStatus from './FederationStatus';

const mockFederationStatus = {
  node_name: 'node-alpha',
  peers: [
    { name: 'node-beta', address: 'beta.example.com:8443', status: 'connected', last_seen: '2025-01-01T12:00:00Z' },
    { name: 'node-gamma', address: 'gamma.example.com:8443', status: 'disconnected', last_seen: '2025-01-01T10:00:00Z' },
  ],
  lamport_ts: 42,
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, defaultValueOrOpts?: string | Record<string, unknown>, opts?: Record<string, unknown>) => {
      if (typeof defaultValueOrOpts === 'string') {
        // t(key, defaultValue, opts?) -- return defaultValue
        return defaultValueOrOpts;
      }
      // t(key, opts) -- return key
      return key;
    },
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

vi.mock('../../services/api', () => ({
  api: {
    getFederationStatus: vi.fn(() => Promise.resolve(mockFederationStatus)),
    generateJoinToken: vi.fn(() => Promise.resolve({ token: 'abc123', join_command: 'dilla join --token abc123' })),
  },
}));

describe('FederationStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  it('renders the federation title', async () => {
    render(<FederationStatus teamId="team-1" />);
    expect(screen.getByText('federation.title')).toBeInTheDocument();
  });

  it('fetches and displays federation status', async () => {
    vi.useRealTimers();
    render(<FederationStatus teamId="team-1" />);
    await waitFor(() => {
      expect(screen.getByText('node-alpha')).toBeInTheDocument();
      expect(screen.getByText('42')).toBeInTheDocument();
    });
  });

  it('displays peer table with peer data', async () => {
    vi.useRealTimers();
    render(<FederationStatus teamId="team-1" />);
    await waitFor(() => {
      expect(screen.getByText('node-beta')).toBeInTheDocument();
      expect(screen.getByText('beta.example.com:8443')).toBeInTheDocument();
      expect(screen.getByText('node-gamma')).toBeInTheDocument();
    });
  });

  it('renders peer status labels', async () => {
    vi.useRealTimers();
    render(<FederationStatus teamId="team-1" />);
    await waitFor(() => {
      expect(screen.getByText('federation.statusConnected')).toBeInTheDocument();
      expect(screen.getByText('federation.statusDisconnected')).toBeInTheDocument();
    });
  });

  it('renders generate join token button', () => {
    render(<FederationStatus teamId="team-1" />);
    expect(screen.getByText('federation.generateJoinToken')).toBeInTheDocument();
  });

  it('generates join token on button click', async () => {
    vi.useRealTimers();
    const { api } = await import('../../services/api');
    render(<FederationStatus teamId="team-1" />);

    fireEvent.click(screen.getByText('federation.generateJoinToken'));

    await waitFor(() => {
      expect(api.generateJoinToken).toHaveBeenCalledWith('team-1');
      expect(screen.getByText('dilla join --token abc123')).toBeInTheDocument();
    });
  });

  it('shows no peers message when empty', async () => {
    vi.useRealTimers();
    const { api } = await import('../../services/api');
    (api.getFederationStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      node_name: 'solo-node',
      peers: [],
      lamport_ts: 0,
    });

    render(<FederationStatus teamId="team-1" />);

    await waitFor(() => {
      expect(screen.getByText('federation.noPeers')).toBeInTheDocument();
    });
  });

  it('shows error when fetch fails', async () => {
    vi.useRealTimers();
    const { api } = await import('../../services/api');
    (api.getFederationStatus as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Network error'));

    render(<FederationStatus teamId="team-1" />);

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
  });

  it('renders auto-refresh notice', () => {
    render(<FederationStatus teamId="team-1" />);
    expect(screen.getByText('federation.autoRefresh')).toBeInTheDocument();
  });
});
