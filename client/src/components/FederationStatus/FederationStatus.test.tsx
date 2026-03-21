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
    t: (key: string, defaultValueOrOpts?: string | Record<string, unknown>, _opts?: Record<string, unknown>) => {
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

function renderFederation() {
  return render(<FederationStatus teamId="team-1" />);
}

function renderFederationWithRealTimers() {
  vi.useRealTimers();
  return renderFederation();
}

async function renderAndWaitForStatus() {
  renderFederationWithRealTimers();
  await waitFor(() => {
    expect(screen.getByText('node-alpha')).toBeInTheDocument();
  });
}

async function generateTokenAndWait() {
  renderFederationWithRealTimers();
  fireEvent.click(screen.getByText('federation.generateJoinToken'));
  await waitFor(() => {
    expect(screen.getByText('dilla join --token abc123')).toBeInTheDocument();
  });
}

describe('FederationStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  it('renders the federation title', async () => {
    renderFederation();
    expect(screen.getByText('federation.title')).toBeInTheDocument();
  });

  it('fetches and displays federation status', async () => {
    renderFederationWithRealTimers();
    await waitFor(() => {
      expect(screen.getByText('node-alpha')).toBeInTheDocument();
      expect(screen.getByText('42')).toBeInTheDocument();
    });
  });

  it('displays peer table with peer data', async () => {
    renderFederationWithRealTimers();
    await waitFor(() => {
      expect(screen.getByText('node-beta')).toBeInTheDocument();
      expect(screen.getByText('beta.example.com:8443')).toBeInTheDocument();
      expect(screen.getByText('node-gamma')).toBeInTheDocument();
    });
  });

  it('renders peer status labels', async () => {
    renderFederationWithRealTimers();
    await waitFor(() => {
      expect(screen.getByText('federation.statusConnected')).toBeInTheDocument();
      expect(screen.getByText('federation.statusDisconnected')).toBeInTheDocument();
    });
  });

  it('renders generate join token button', () => {
    renderFederation();
    expect(screen.getByText('federation.generateJoinToken')).toBeInTheDocument();
  });

  it('generates join token on button click', async () => {
    const { api } = await import('../../services/api');
    await generateTokenAndWait();
    expect(api.generateJoinToken).toHaveBeenCalledWith('team-1');
  });

  it('shows no peers message when empty', async () => {
    vi.useRealTimers();
    const { api } = await import('../../services/api');
    vi.mocked(api.getFederationStatus).mockResolvedValueOnce({
      node_name: 'solo-node',
      peers: [],
      lamport_ts: 0,
    });
    renderFederation();
    await waitFor(() => {
      expect(screen.getByText('federation.noPeers')).toBeInTheDocument();
    });
  });

  it('shows error when fetch fails', async () => {
    vi.useRealTimers();
    const { api } = await import('../../services/api');
    vi.mocked(api.getFederationStatus).mockRejectedValueOnce(new Error('Network error'));
    renderFederation();
    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
  });

  it('renders auto-refresh notice', () => {
    renderFederation();
    expect(screen.getByText('federation.autoRefresh')).toBeInTheDocument();
  });

  it('shows mesh summary with connected/disconnected counts', async () => {
    await renderAndWaitForStatus();
    expect(screen.getByText('federation.meshSummary')).toBeInTheDocument();
  });

  it('displays syncing status label', async () => {
    vi.useRealTimers();
    const { api } = await import('../../services/api');
    vi.mocked(api.getFederationStatus).mockResolvedValueOnce({
      node_name: 'node-sync',
      peers: [{ name: 'node-sync', address: 'sync.io:8443', status: 'syncing', last_seen: '2025-01-01T12:00:00Z' }],
      lamport_ts: 10,
    });
    renderFederation();
    await waitFor(() => {
      expect(screen.getByText('federation.statusSyncing')).toBeInTheDocument();
    });
  });

  it('shows copy button for join command', async () => {
    await generateTokenAndWait();
    const copyBtns = screen.getAllByText('federation.copyToClipboard');
    expect(copyBtns.length).toBe(2);
  });

  it('shows curl one-liner after generating token', async () => {
    await generateTokenAndWait();
    expect(screen.getByText(/curl -sSL https:\/\/get\.dilla\.dev/)).toBeInTheDocument();
  });

  it('shows generating state on button while generating', async () => {
    vi.useRealTimers();
    const { api } = await import('../../services/api');
    let resolveToken: (v: unknown) => void;
    const tokenPromise = new Promise(r => { resolveToken = r; });
    vi.mocked(api.generateJoinToken).mockReturnValueOnce(tokenPromise);

    renderFederation();
    fireEvent.click(screen.getByText('federation.generateJoinToken'));

    // Button should show '...' while generating
    expect(screen.getByText('...')).toBeInTheDocument();
    resolveToken!({ token: 'abc', join_command: 'dilla join --token abc' });
    await waitFor(() => {
      expect(screen.getByText('dilla join --token abc')).toBeInTheDocument();
    });
  });

  it('shows error when token generation fails', async () => {
    vi.useRealTimers();
    const { api } = await import('../../services/api');
    vi.mocked(api.generateJoinToken).mockRejectedValueOnce(new Error('Token generation failed'));

    renderFederation();
    fireEvent.click(screen.getByText('federation.generateJoinToken'));
    await waitFor(() => {
      expect(screen.getByText('Token generation failed')).toBeInTheDocument();
    });
  });

  it('renders node info section with lamport timestamp', async () => {
    await renderAndWaitForStatus();
    expect(screen.getByText('federation.nodeInfo')).toBeInTheDocument();
    expect(screen.getByText('federation.lamportTimestamp')).toBeInTheDocument();
  });

  it('copies join command to clipboard', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: writeTextMock } });
    await generateTokenAndWait();
    const copyBtns = screen.getAllByText('federation.copyToClipboard');
    fireEvent.click(copyBtns[0]);
    expect(writeTextMock).toHaveBeenCalledWith('dilla join --token abc123');
  });

  it('handles clipboard API failure gracefully', async () => {
    const writeTextMock = vi.fn().mockRejectedValue(new Error('not supported'));
    Object.assign(navigator, { clipboard: { writeText: writeTextMock } });
    await generateTokenAndWait();
    const copyBtns = screen.getAllByText('federation.copyToClipboard');
    fireEvent.click(copyBtns[0]);
    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith('dilla join --token abc123');
    });
  });

  it('copies curl one-liner to clipboard', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: writeTextMock } });
    await generateTokenAndWait();
    const copyBtns = screen.getAllByText('federation.copyToClipboard');
    fireEvent.click(copyBtns[1]);
    expect(writeTextMock).toHaveBeenCalledWith(expect.stringContaining('curl -sSL'));
  });

  it('handles invalid date gracefully in formatLastSeen', async () => {
    vi.useRealTimers();
    const { api } = await import('../../services/api');
    vi.mocked(api.getFederationStatus).mockResolvedValueOnce({
      node_name: 'node-test',
      peers: [{ name: 'peer-1', address: 'addr:8443', status: 'connected', last_seen: 'invalid-date' }],
      lamport_ts: 5,
    });
    renderFederation();
    await waitFor(() => {
      expect(screen.getByText('peer-1')).toBeInTheDocument();
    });
  });

  it('shows copied state after copying', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    await generateTokenAndWait();
    const copyBtns = screen.getAllByText('federation.copyToClipboard');
    fireEvent.click(copyBtns[0]);

    await waitFor(() => {
      expect(screen.getByText('federation.copied')).toBeInTheDocument();
    });
  });

  it('formatLastSeen returns raw string when Date constructor throws', async () => {
    vi.useRealTimers();
    const { api } = await import('../../services/api');
    const spy = vi.spyOn(Date.prototype, 'toLocaleString').mockImplementation(() => { throw new Error('locale error'); });

    vi.mocked(api.getFederationStatus).mockResolvedValueOnce({
      node_name: 'node-fallback',
      peers: [{ name: 'peer-err', address: 'err:8443', status: 'connected', last_seen: 'raw-fallback-string' }],
      lamport_ts: 1,
    });
    renderFederation();
    await waitFor(() => {
      expect(screen.getByText('raw-fallback-string')).toBeInTheDocument();
    });

    spy.mockRestore();
  });
});
