import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const mockNavigate = vi.fn();

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useParams: vi.fn(() => ({})),
}));

vi.mock('iconoir-react', () => ({
  CloudCheck: () => <span data-testid="CloudCheck" />,
  CloudXmark: () => <span data-testid="CloudXmark" />,
  CloudSync: () => <span data-testid="CloudSync" />,
}));

vi.mock('../services/api', () => ({
  api: {
    addTeam: vi.fn(),
    removeTeam: vi.fn(),
    setToken: vi.fn(),
    register: vi.fn(),
    getInviteInfo: vi.fn(),
    uploadPrekeyBundle: vi.fn(),
  },
}));

vi.mock('../services/crypto', () => ({
  cryptoService: {
    generatePrekeyBundle: vi.fn().mockResolvedValue({
      identity_key: [1, 2, 3],
      signed_prekey: [4, 5, 6],
      signed_prekey_signature: [7, 8, 9],
      one_time_prekeys: [[10, 11, 12]],
    }),
  },
}));

vi.mock('../services/keyStore', () => ({
  exportIdentityBlob: vi.fn().mockResolvedValue(null),
  hasIdentity: vi.fn().mockResolvedValue(true),
}));

vi.mock('./PublicShell', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="public-shell">{children}</div>
  ),
}));

import JoinTeam from './JoinTeam';
import { useAuthStore } from '../stores/authStore';
import { api } from '../services/api';
import { useParams } from 'react-router-dom';

// Save original fetch
const origFetch = globalThis.fetch;

describe('JoinTeam', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigate.mockClear();
    useAuthStore.setState({
      isAuthenticated: true,
      derivedKey: 'test-key',
      publicKey: 'test-pub-key',
      teams: new Map(),
      addTeam: vi.fn(),
    });
    vi.mocked(useParams).mockReturnValue({});
    // Default: fetch rejects (server offline)
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network'));
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('renders the join form', async () => {
    render(<JoinTeam />);
    await act(async () => {});
    expect(screen.getByRole('heading', { name: 'join.title' })).toBeInTheDocument();
    expect(screen.getByTestId('public-shell')).toBeInTheDocument();
  });

  it('renders server address input', async () => {
    render(<JoinTeam />);
    await act(async () => {});
    expect(screen.getByPlaceholderText('join.serverAddress')).toBeInTheDocument();
  });

  it('renders invite token input', async () => {
    render(<JoinTeam />);
    await act(async () => {});
    expect(screen.getByPlaceholderText('join.inviteToken')).toBeInTheDocument();
  });

  it('renders username input', async () => {
    render(<JoinTeam />);
    await act(async () => {});
    expect(screen.getByPlaceholderText('Username')).toBeInTheDocument();
  });

  it('renders display name input', async () => {
    render(<JoinTeam />);
    await act(async () => {});
    expect(screen.getByPlaceholderText('Display Name')).toBeInTheDocument();
  });

  it('shows back button that navigates back', async () => {
    render(<JoinTeam />);
    await act(async () => {});
    const backBtn = screen.getByText(/Back/);
    expect(backBtn).toBeInTheDocument();
    fireEvent.click(backBtn);
    expect(mockNavigate).toHaveBeenCalledWith(-1);
  });

  it('shows setup server link', async () => {
    render(<JoinTeam />);
    await act(async () => {});
    expect(screen.getByText('Set up a new server instead')).toBeInTheDocument();
  });

  it('auto-fills server when arriving via invite link', async () => {
    vi.mocked(useParams).mockReturnValue({ token: 'abc123' });
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });

    render(<JoinTeam />);
    await act(async () => {});

    // When fromInviteLink, server address and invite token inputs are hidden
    expect(screen.queryByPlaceholderText('join.serverAddress')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('join.inviteToken')).not.toBeInTheDocument();
  });

  it('redirects to /app when authenticated with teams and no invite', async () => {
    useAuthStore.setState({
      isAuthenticated: true,
      teams: new Map([['t1', { token: 'tok', user: {}, teamInfo: {}, baseUrl: 'http://localhost' }]]),
    });

    render(<JoinTeam />);
    await act(async () => {});
    expect(mockNavigate).toHaveBeenCalledWith('/app', { replace: true });
  });

  it('shows error on failed invite check', async () => {
    vi.mocked(api.getInviteInfo).mockRejectedValueOnce(new Error('Invalid invite'));
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });

    render(<JoinTeam />);

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('join.serverAddress'), {
        target: { value: 'https://example.com' },
      });
    });

    // Wait for debounced server check
    await waitFor(() => {
      expect(screen.getByTestId('CloudCheck')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('join.inviteToken'), {
        target: { value: 'invite-token-123' },
      });
      fireEvent.change(screen.getByPlaceholderText('Username'), {
        target: { value: 'alice' },
      });
    });

    const joinBtn = screen.getByText('join.title', { selector: 'button' });
    fireEvent.click(joinBtn);

    await waitFor(() => {
      expect(screen.getByText(/Invalid invite/)).toBeInTheDocument();
    });
  });

  it('shows team info after successful invite check', async () => {
    vi.mocked(api.getInviteInfo).mockResolvedValueOnce({
      team_name: 'Cool Team',
      created_by: 'admin',
    });
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });

    render(<JoinTeam />);

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('join.serverAddress'), {
        target: { value: 'https://example.com' },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('CloudCheck')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('join.inviteToken'), {
        target: { value: 'invite-token-123' },
      });
      fireEvent.change(screen.getByPlaceholderText('Username'), {
        target: { value: 'alice' },
      });
    });

    fireEvent.click(screen.getByText('join.title', { selector: 'button' }));

    await waitFor(() => {
      expect(screen.getByText('Cool Team')).toBeInTheDocument();
    });
  });

  it('navigates to /app on successful join', async () => {
    vi.mocked(api.getInviteInfo).mockResolvedValueOnce({
      team_name: 'Cool Team',
      created_by: 'admin',
    });
    vi.mocked(api.register).mockResolvedValueOnce({
      token: 'jwt-tok',
      user: { id: 'u1', username: 'alice' },
      team: { id: 'team-1' },
    });
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });

    render(<JoinTeam />);

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('join.serverAddress'), {
        target: { value: 'https://example.com' },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('CloudCheck')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('join.inviteToken'), {
        target: { value: 'invite-token' },
      });
      fireEvent.change(screen.getByPlaceholderText('Username'), {
        target: { value: 'alice' },
      });
    });

    // First check invite info
    fireEvent.click(screen.getByText('join.title', { selector: 'button' }));

    await waitFor(() => {
      expect(screen.getByText('Cool Team')).toBeInTheDocument();
    });

    // Now click the actual join button
    fireEvent.click(screen.getByText('join.join'));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/app');
    });
  });

  it('shows offline icon when server is unreachable', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network'));
    render(<JoinTeam />);

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('join.serverAddress'), {
        target: { value: 'https://bad-server.com' },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('CloudXmark')).toBeInTheDocument();
    });
  });

  it('shows online icon when server responds ok', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
    render(<JoinTeam />);

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('join.serverAddress'), {
        target: { value: 'https://good-server.com' },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('CloudCheck')).toBeInTheDocument();
    });
  });

  it('navigates to /setup when setup link clicked', async () => {
    render(<JoinTeam />);
    await act(async () => {});
    fireEvent.click(screen.getByText('Set up a new server instead'));
    expect(mockNavigate).toHaveBeenCalledWith('/setup');
  });

  it('shows error when not authenticated (no derivedKey)', async () => {
    useAuthStore.setState({ derivedKey: null, publicKey: null });

    vi.mocked(api.getInviteInfo).mockResolvedValueOnce({
      team_name: 'Team',
      created_by: 'admin',
    });
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });

    render(<JoinTeam />);

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('join.serverAddress'), {
        target: { value: 'https://example.com' },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('CloudCheck')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('join.inviteToken'), {
        target: { value: 'token' },
      });
      fireEvent.change(screen.getByPlaceholderText('Username'), {
        target: { value: 'bob' },
      });
    });

    fireEvent.click(screen.getByText('join.title', { selector: 'button' }));

    await waitFor(() => {
      expect(screen.getByText('Team')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('join.join'));

    await waitFor(() => {
      expect(screen.getByText('Not authenticated')).toBeInTheDocument();
    });
  });

  it('shows invited by info when available', async () => {
    vi.mocked(api.getInviteInfo).mockResolvedValueOnce({
      team_name: 'Cool Team',
      created_by: 'adminuser',
    });
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });

    render(<JoinTeam />);

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('join.serverAddress'), {
        target: { value: 'https://example.com' },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('CloudCheck')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('join.inviteToken'), {
        target: { value: 'token' },
      });
      fireEvent.change(screen.getByPlaceholderText('Username'), {
        target: { value: 'alice' },
      });
    });

    fireEvent.click(screen.getByText('join.title', { selector: 'button' }));

    await waitFor(() => {
      expect(screen.getByText(/adminuser/)).toBeInTheDocument();
    });
  });

  it('disables join button when server is not online', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network'));
    render(<JoinTeam />);

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('join.serverAddress'), {
        target: { value: 'https://bad.com' },
      });
      fireEvent.change(screen.getByPlaceholderText('join.inviteToken'), {
        target: { value: 'tok' },
      });
      fireEvent.change(screen.getByPlaceholderText('Username'), {
        target: { value: 'bob' },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('CloudXmark')).toBeInTheDocument();
    });

    const joinBtn = screen.getByText('join.title', { selector: 'button' });
    expect(joinBtn).toBeDisabled();
  });

  it('shows display name input with localStorage default', async () => {
    localStorage.setItem('dilla_username', 'stored-name');
    render(<JoinTeam />);
    await act(async () => {});
    const displayInput = screen.getByPlaceholderText('Display Name');
    expect(displayInput).toHaveValue('stored-name');
    localStorage.removeItem('dilla_username');
  });

  it('redirects to create-identity when no identity exists and no derivedKey', async () => {
    const { hasIdentity } = await import('../services/keyStore');
    vi.mocked(hasIdentity).mockResolvedValue(false);
    useAuthStore.setState({ derivedKey: null, publicKey: null });

    render(<JoinTeam />);
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/create-identity', { replace: true });
    });
  });

  it('stores pending invite token in session storage before redirect', async () => {
    const { hasIdentity } = await import('../services/keyStore');
    vi.mocked(hasIdentity).mockResolvedValue(false);
    vi.mocked(useParams).mockReturnValue({ token: 'invite-abc' });
    useAuthStore.setState({ derivedKey: null, publicKey: null });

    render(<JoinTeam />);
    await waitFor(() => {
      expect(sessionStorage.getItem('pendingInviteToken')).toBe('invite-abc');
    });
  });

  it('handles join error from registration API', async () => {
    vi.mocked(api.getInviteInfo).mockResolvedValueOnce({
      team_name: 'Team',
      created_by: 'admin',
    });
    vi.mocked(api.register).mockRejectedValueOnce(new Error('Registration failed'));
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });

    render(<JoinTeam />);

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('join.serverAddress'), {
        target: { value: 'https://example.com' },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('CloudCheck')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('join.inviteToken'), {
        target: { value: 'token' },
      });
      fireEvent.change(screen.getByPlaceholderText('Username'), {
        target: { value: 'alice' },
      });
    });

    fireEvent.click(screen.getByText('join.title', { selector: 'button' }));

    await waitFor(() => {
      expect(screen.getByText('Team')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('join.join'));

    await waitFor(() => {
      expect(screen.getByText(/Registration failed/)).toBeInTheDocument();
    });
  });

  it('does nothing on check invite if server address is empty', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });

    render(<JoinTeam />);
    await act(async () => {});

    // Leave server address empty
    fireEvent.change(screen.getByPlaceholderText('join.inviteToken'), {
      target: { value: 'token' },
    });

    // Button should be disabled because server is not online
    const joinBtn = screen.getByText('join.title', { selector: 'button' });
    expect(joinBtn).toBeDisabled();
  });

  it('normalizes server address without http prefix', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
    vi.mocked(api.getInviteInfo).mockResolvedValueOnce({
      team_name: 'Team',
      created_by: 'admin',
    });

    render(<JoinTeam />);

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('join.serverAddress'), {
        target: { value: 'example.com' },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('CloudCheck')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('join.inviteToken'), {
        target: { value: 'token' },
      });
      fireEvent.change(screen.getByPlaceholderText('Username'), {
        target: { value: 'alice' },
      });
    });

    fireEvent.click(screen.getByText('join.title', { selector: 'button' }));

    await waitFor(() => {
      expect(api.getInviteInfo).toHaveBeenCalledWith('https://example.com', 'token');
    });
  });

  it('shows invite link auto-check for invite link with team info', async () => {
    vi.mocked(useParams).mockReturnValue({ token: 'abc123' });
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
    vi.mocked(api.getInviteInfo).mockResolvedValueOnce({
      team_name: 'Auto Team',
      created_by: 'admin',
    });

    render(<JoinTeam />);
    await waitFor(() => {
      expect(screen.getByText('Auto Team')).toBeInTheDocument();
    });
  });

  it('handles join with team id in result that differs from tempId', async () => {
    vi.mocked(api.getInviteInfo).mockResolvedValueOnce({
      team_name: 'Team',
      created_by: 'admin',
    });
    vi.mocked(api.register).mockResolvedValueOnce({
      token: 'jwt-tok',
      user: { id: 'u1', username: 'alice' },
      team: { id: 'real-team-id' },
    });
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });

    render(<JoinTeam />);

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('join.serverAddress'), {
        target: { value: 'https://example.com' },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('CloudCheck')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('join.inviteToken'), {
        target: { value: 'token' },
      });
      fireEvent.change(screen.getByPlaceholderText('Username'), {
        target: { value: 'alice' },
      });
    });

    fireEvent.click(screen.getByText('join.title', { selector: 'button' }));

    await waitFor(() => {
      expect(screen.getByText('Team')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('join.join'));

    await waitFor(() => {
      expect(api.removeTeam).toHaveBeenCalled();
      expect(api.addTeam).toHaveBeenCalledWith('real-team-id', 'https://example.com');
      expect(mockNavigate).toHaveBeenCalledWith('/app');
    });
  });

  it('handles server health returning non-ok', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false });
    render(<JoinTeam />);

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('join.serverAddress'), {
        target: { value: 'https://bad-server.com' },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('CloudXmark')).toBeInTheDocument();
    });
  });

  it('clears server status when address is emptied', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
    render(<JoinTeam />);

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('join.serverAddress'), {
        target: { value: 'https://example.com' },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('CloudCheck')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('join.serverAddress'), {
        target: { value: '' },
      });
    });

    await waitFor(() => {
      // Neither CloudCheck nor CloudXmark should be shown
      expect(screen.queryByTestId('CloudCheck')).not.toBeInTheDocument();
      expect(screen.queryByTestId('CloudXmark')).not.toBeInTheDocument();
    });
  });
});
