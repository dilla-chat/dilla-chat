import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

const mockNavigate = vi.fn();

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useSearchParams: () => [new URLSearchParams()],
}));

vi.mock('@tabler/icons-react', () => ({
  IconCloudCheck: () => <span data-testid="CloudCheck" />,
  IconCloudOff: () => <span data-testid="CloudXmark" />,
  IconCloudComputing: () => <span data-testid="CloudSync" />,
}));

vi.mock('../services/api', () => ({
  api: {
    addTeam: vi.fn(),
    removeTeam: vi.fn(),
    setToken: vi.fn(),
    requestChallenge: vi.fn().mockResolvedValue({ challenge_id: 'ch-1', nonce: 'AAAA' }),
    bootstrap: vi.fn(),
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
  getIdentityKeys: vi.fn(() => ({ signingKey: 'mock-signing-key' })),
}));

vi.mock('../services/keyStore', () => ({
  exportIdentityBlob: vi.fn().mockResolvedValue(null),
  hasIdentity: vi.fn().mockResolvedValue(true),
  signChallenge: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
}));

vi.mock('../services/cryptoCore', () => ({
  fromBase64: vi.fn().mockReturnValue(new Uint8Array([0])),
  generateEd25519KeyPair: vi.fn().mockResolvedValue({
    privateKey: 'mock-priv',
    publicKeyBytes: new Uint8Array([1, 2, 3]),
  }),
  ed25519Sign: vi.fn().mockResolvedValue(new Uint8Array([4, 5, 6])),
}));

vi.mock('./PublicShell', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="public-shell">{children}</div>
  ),
}));

vi.mock('../utils/serverConnection', () => ({
  normalizeServerUrl: vi.fn((url: string) => url),
  useServerHealthCheck: vi.fn(() => ['online']),
  uploadPrekeyBundle: vi.fn().mockResolvedValue(undefined),
  activateTeamAndNavigate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../utils/errorMessages', () => ({
  friendlyError: vi.fn((e: Error) => e.message ?? 'Unknown error'),
}));

import SetupAdmin from './SetupAdmin';
import { useAuthStore } from '../stores/authStore';

const origFetch = globalThis.fetch;

describe('SetupAdmin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigate.mockClear();
    useAuthStore.setState({
      isAuthenticated: true,
      derivedKey: { signingKey: 'mock-signing-key' },
      publicKey: 'test-pub-key',
      teams: new Map(),
      addTeam: vi.fn(),
      setPublicKey: vi.fn(),
    });
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('renders the setup form', async () => {
    render(<SetupAdmin />);
    await act(async () => {});
    expect(screen.getByRole('heading', { name: 'setup.title' })).toBeInTheDocument();
    expect(screen.getByTestId('public-shell')).toBeInTheDocument();
  });

  it('renders bootstrap token input', async () => {
    render(<SetupAdmin />);
    await act(async () => {});
    expect(screen.getByPlaceholderText('setup.bootstrapToken')).toBeInTheDocument();
  });

  it('renders team name input', async () => {
    render(<SetupAdmin />);
    await act(async () => {});
    expect(screen.getByPlaceholderText('Team Name')).toBeInTheDocument();
  });

  it('renders username input', async () => {
    render(<SetupAdmin />);
    await act(async () => {});
    expect(screen.getByPlaceholderText('Username')).toBeInTheDocument();
  });

  it('renders display name input', async () => {
    render(<SetupAdmin />);
    await act(async () => {});
    expect(screen.getByPlaceholderText('Display Name')).toBeInTheDocument();
  });

  it('shows back button that navigates back', async () => {
    render(<SetupAdmin />);
    await act(async () => {});
    const backBtn = screen.getByText(/Back/);
    expect(backBtn).toBeInTheDocument();
    fireEvent.click(backBtn);
    expect(mockNavigate).toHaveBeenCalledWith(-1);
  });

  it('disables setup button when fields are empty', async () => {
    render(<SetupAdmin />);
    await act(async () => {});
    const setupBtn = screen.getByRole('button', { name: 'setup.setup' });
    expect(setupBtn).toBeDisabled();
  });

  it('redirects to create-identity when no identity exists', async () => {
    const { hasIdentity } = await import('../services/keyStore');
    vi.mocked(hasIdentity).mockResolvedValueOnce(false);
    render(<SetupAdmin />);
    await act(async () => {});
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.stringContaining('/create-identity'),
    );
  });

  it('submits setup and navigates on success', async () => {
    const { api } = await import('../services/api');
    vi.mocked(api.bootstrap).mockResolvedValueOnce({
      token: 'jwt-tok',
      user: { id: 'u1', username: 'admin' },
      team: { id: 'team-1', name: 'MyTeam' },
    });

    render(<SetupAdmin />);
    await act(async () => {});

    fireEvent.change(screen.getByPlaceholderText('setup.bootstrapToken'), { target: { value: 'tok123' } });
    fireEvent.change(screen.getByPlaceholderText('Username'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByPlaceholderText('Team Name'), { target: { value: 'MyTeam' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'setup.setup' }));
    });

    // Wait for async handleSetup to complete
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    expect(api.bootstrap).toHaveBeenCalled();
  });

  it('updates input values on change', async () => {
    render(<SetupAdmin />);
    await act(async () => {});

    const tokenInput = screen.getByPlaceholderText('setup.bootstrapToken');
    fireEvent.change(tokenInput, { target: { value: 'my-token' } });
    expect(tokenInput).toHaveValue('my-token');

    const teamInput = screen.getByPlaceholderText('Team Name');
    fireEvent.change(teamInput, { target: { value: 'My Team' } });
    expect(teamInput).toHaveValue('My Team');

    const usernameInput = screen.getByPlaceholderText('Username');
    fireEvent.change(usernameInput, { target: { value: 'admin' } });
    expect(usernameInput).toHaveValue('admin');
  });
});
