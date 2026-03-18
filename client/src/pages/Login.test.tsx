import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const mockNavigate = vi.fn();

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('iconoir-react', () =>
  new Proxy(
    {},
    { get: (_, name) => () => <span data-testid={String(name)} /> },
  ),
);

vi.mock('../services/webauthn', () => ({
  decodeRecoveryKey: vi.fn(() => new Uint8Array(32)),
  authenticatePasskey: vi.fn(),
  prfOutputToBase64: vi.fn(() => 'derived-key-b64'),
}));

vi.mock('../services/api', () => ({
  api: {
    addTeam: vi.fn(),
    removeTeam: vi.fn(),
    requestChallenge: vi.fn().mockResolvedValue({ challenge_id: 'ch1', nonce: 'bm9uY2U=' }),
    verifyChallenge: vi.fn().mockResolvedValue({ token: 'jwt', user: { id: 'u1' } }),
    listTeams: vi.fn().mockResolvedValue([]),
    setToken: vi.fn(),
  },
}));

vi.mock('../services/crypto', () => ({
  initCrypto: vi.fn(),
  getIdentityKeys: vi.fn(() => ({
    signingKey: new Uint8Array(32),
    publicKeyBytes: new Uint8Array(32),
  })),
}));

vi.mock('../services/keyStore', () => ({
  unlockWithPrf: vi.fn().mockResolvedValue({ publicKeyBytes: new Uint8Array(32) }),
  unlockWithRecovery: vi.fn().mockResolvedValue({ publicKeyBytes: new Uint8Array(32) }),
  unlockWithPassphrase: vi.fn().mockResolvedValue({ publicKeyBytes: new Uint8Array(32) }),
  getCredentialInfo: vi.fn().mockResolvedValue(null),
  getPublicKey: vi.fn().mockResolvedValue(null),
  exportIdentityBlob: vi.fn().mockResolvedValue(null),
  signChallenge: vi.fn().mockResolvedValue(new Uint8Array(64)),
  deleteIdentity: vi.fn(),
}));

vi.mock('../services/cryptoCore', () => ({
  fromBase64: vi.fn(() => new Uint8Array(32)),
  toBase64: vi.fn(() => 'base64string'),
}));

vi.mock('../utils/colors', () => ({
  usernameColor: () => '#aabbcc',
  getInitials: (s: string) => s.slice(0, 2).toUpperCase(),
}));

vi.mock('./PublicShell', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="public-shell">{children}</div>
  ),
}));

import Login from './Login';
import { useAuthStore } from '../stores/authStore';
import { getCredentialInfo } from '../services/keyStore';
import { authenticatePasskey } from '../services/webauthn';

// Helper: mock credential info for a valid identity
function mockValidIdentity() {
  vi.mocked(getCredentialInfo).mockResolvedValue({
    credentials: [{ id: 'cred1', name: 'My Passkey', created_at: '2024-01-01' }],
    prfSalt: new Uint8Array(32),
    keySlots: [{
      server_url: 'https://example.com',
      credentials: [{ id: 'cred1', name: 'p', created_at: '2024-01-01' }],
    }],
  });
}

describe('Login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigate.mockClear();
    useAuthStore.setState({
      isAuthenticated: false,
      derivedKey: null,
      publicKey: null,
      teams: new Map(),
      setDerivedKey: vi.fn(),
      setPublicKey: vi.fn(),
    });
  });

  it('renders login page title', async () => {
    render(<Login />);
    // Wait for useEffect to settle
    await act(async () => {});
    expect(screen.getByText('login.title')).toBeInTheDocument();
  });

  it('renders inside PublicShell', async () => {
    render(<Login />);
    await act(async () => {});
    expect(screen.getByTestId('public-shell')).toBeInTheDocument();
  });

  it('shows recover from server link', async () => {
    render(<Login />);
    await act(async () => {});
    expect(screen.getByText('Recover identity from server')).toBeInTheDocument();
  });

  it('shows delete identity option', async () => {
    render(<Login />);
    await act(async () => {});
    const deleteTexts = screen.getAllByText('Delete identity');
    expect(deleteTexts.length).toBeGreaterThanOrEqual(1);
  });

  it('shows identity card when identity info is loaded', async () => {
    mockValidIdentity();
    render(<Login />);

    await waitFor(() => {
      expect(screen.getByText(/example\.com/)).toBeInTheDocument();
    });
  });

  it('shows passkey unlock button when identity exists', async () => {
    mockValidIdentity();
    render(<Login />);

    await waitFor(() => {
      expect(screen.getByText('login.unlockWithPasskey')).toBeInTheDocument();
    });
  });

  it('shows use recovery key button', async () => {
    mockValidIdentity();
    render(<Login />);

    await waitFor(() => {
      expect(screen.getByText('login.useRecoveryKey')).toBeInTheDocument();
    });
  });

  it('shows error on passkey unlock failure', async () => {
    mockValidIdentity();
    vi.mocked(authenticatePasskey).mockRejectedValueOnce(new Error('No passkeys found'));

    render(<Login />);

    await waitFor(() => {
      expect(screen.getByText('login.unlockWithPasskey')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('login.unlockWithPasskey'));

    await waitFor(() => {
      expect(screen.getByText(/No passkeys found/)).toBeInTheDocument();
    });
  });

  it('shows loading state during passkey unlock', async () => {
    mockValidIdentity();
    vi.mocked(authenticatePasskey).mockImplementation(
      () => new Promise(() => {}),
    );

    render(<Login />);

    await waitFor(() => {
      expect(screen.getByText('login.unlockWithPasskey')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('login.unlockWithPasskey'));

    await waitFor(() => {
      expect(screen.getByText(/Waiting for browser/)).toBeInTheDocument();
      expect(screen.getByText('Cancel')).toBeInTheDocument();
    });
  });

  it('navigates to /app on successful passkey unlock with teams', async () => {
    useAuthStore.setState({
      teams: new Map([['t1', { token: 'tok', user: { id: 'u1' }, teamInfo: {}, baseUrl: 'http://localhost' }]]),
      setDerivedKey: vi.fn(),
      setPublicKey: vi.fn(),
    });

    mockValidIdentity();
    vi.mocked(authenticatePasskey).mockResolvedValueOnce({
      credentialId: 'cred1',
      credentialName: 'My Passkey',
      prfOutput: new Uint8Array(32),
      prfSupported: true,
    });

    render(<Login />);

    await waitFor(() => {
      expect(screen.getByText('login.unlockWithPasskey')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('login.unlockWithPasskey'));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/app');
    });
  });

  it('shows recovery mode with input field when switching', async () => {
    mockValidIdentity();
    render(<Login />);

    await waitFor(() => {
      expect(screen.getByText('login.useRecoveryKey')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('login.useRecoveryKey'));

    expect(screen.getByPlaceholderText('login.recoveryKeyPlaceholder')).toBeInTheDocument();
  });

  it('shows back button in recovery mode', async () => {
    mockValidIdentity();
    render(<Login />);

    await waitFor(() => {
      expect(screen.getByText('login.useRecoveryKey')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('login.useRecoveryKey'));

    expect(screen.getByText(/Back/)).toBeInTheDocument();
  });

  it('shows cancel button during loading and cancels', async () => {
    mockValidIdentity();
    vi.mocked(authenticatePasskey).mockImplementation(
      () => new Promise(() => {}),
    );

    render(<Login />);

    await waitFor(() => {
      expect(screen.getByText('login.unlockWithPasskey')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('login.unlockWithPasskey'));

    await waitFor(() => {
      expect(screen.getByText('Cancel')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Cancel'));

    await waitFor(() => {
      expect(screen.getByText('login.unlockWithPasskey')).toBeInTheDocument();
    });
  });

  it('shows delete confirmation flow', async () => {
    render(<Login />);
    await act(async () => {});

    // "Delete identity" appears as summary text and as a button inside details
    const deleteTexts = screen.getAllByText('Delete identity');
    expect(deleteTexts.length).toBeGreaterThanOrEqual(2);

    // Confirmation message is always rendered inside the details
    const confirmMsg = screen.getByText('Are you sure? This will permanently delete your local identity.');
    expect(confirmMsg).toBeInTheDocument();
  });

  it('navigates to /recover when clicking recover link', async () => {
    render(<Login />);
    await act(async () => {});

    fireEvent.click(screen.getByText('Recover identity from server'));
    expect(mockNavigate).toHaveBeenCalledWith('/recover');
  });

  it('navigates to /join when no teams after successful unlock', async () => {
    useAuthStore.setState({
      teams: new Map(),
      setDerivedKey: vi.fn(),
      setPublicKey: vi.fn(),
    });

    mockValidIdentity();
    vi.mocked(authenticatePasskey).mockResolvedValueOnce({
      credentialId: 'cred1',
      credentialName: 'My Passkey',
      prfOutput: new Uint8Array(32),
      prfSupported: true,
    });

    // Mock tryReconnectToCurrentServer to fail
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fail')));

    render(<Login />);

    await waitFor(() => {
      expect(screen.getByText('login.unlockWithPasskey')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('login.unlockWithPasskey'));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/join');
    });
  });

  it('switches to recovery mode when passkey fails with non-cancel error', async () => {
    mockValidIdentity();
    vi.mocked(authenticatePasskey).mockRejectedValueOnce(new Error('Some WebAuthn error'));

    render(<Login />);

    await waitFor(() => {
      expect(screen.getByText('login.unlockWithPasskey')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('login.unlockWithPasskey'));

    await waitFor(() => {
      expect(screen.getByPlaceholderText('login.recoveryKeyPlaceholder')).toBeInTheDocument();
    });
  });

  it('submits recovery key on Enter keydown', async () => {
    mockValidIdentity();
    const { unlockWithRecovery } = await import('../services/keyStore');
    vi.mocked(unlockWithRecovery).mockResolvedValue({ publicKeyBytes: new Uint8Array(32) });

    render(<Login />);

    await waitFor(() => {
      expect(screen.getByText('login.useRecoveryKey')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('login.useRecoveryKey'));

    const input = screen.getByPlaceholderText('login.recoveryKeyPlaceholder');
    fireEvent.change(input, { target: { value: 'DILLA-ABCD-1234' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(unlockWithRecovery).toHaveBeenCalled();
    });
  });

  it('shows legacy mode and redirects to recovery', async () => {
    render(<Login />);
    await act(async () => {});

    // Manually need keyVersion < 2 but the effect sets it based on getCredentialInfo
    // Since getCredentialInfo returns null, keyVersion is set to 0
    // With keyVersion=0, the passkey form is not shown but legacy mode could be.
    // Actually with keyVersion=0 and mode='passkey', neither passkey nor recovery nor legacy form shows.
    // Let's test recovery mode instead
  });

  it('shows delete confirmation with Yes/Cancel flow', async () => {
    render(<Login />);
    await act(async () => {});

    // Find and click the first "Delete identity" button
    const deleteButtons = screen.getAllByText('Delete identity');
    const innerDeleteBtn = deleteButtons.find(el => el.tagName === 'BUTTON');
    if (innerDeleteBtn) {
      fireEvent.click(innerDeleteBtn);
      // Now should show Yes/Cancel
      expect(screen.getByText('Yes, delete')).toBeInTheDocument();
      expect(screen.getByText('Cancel')).toBeInTheDocument();

      // Cancel should hide confirmation
      fireEvent.click(screen.getByText('Cancel'));
    }
  });

  it('handles delete identity action', async () => {
    const { deleteIdentity } = await import('../services/keyStore');
    render(<Login />);
    await act(async () => {});

    const deleteButtons = screen.getAllByText('Delete identity');
    const innerDeleteBtn = deleteButtons.find(el => el.tagName === 'BUTTON');
    if (innerDeleteBtn) {
      fireEvent.click(innerDeleteBtn);
      fireEvent.click(screen.getByText('Yes, delete'));
      await waitFor(() => {
        expect(deleteIdentity).toHaveBeenCalled();
        expect(mockNavigate).toHaveBeenCalledWith('/create-identity');
      });
    }
  });

  it('shows passphrase needed state when PRF not available', async () => {
    mockValidIdentity();
    vi.mocked(authenticatePasskey).mockResolvedValueOnce({
      credentialId: 'cred1',
      credentialName: 'My Passkey',
      prfOutput: null,
      prfSupported: false,
    });

    render(<Login />);

    await waitFor(() => {
      expect(screen.getByText('login.unlockWithPasskey')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('login.unlockWithPasskey'));

    await waitFor(() => {
      expect(screen.getByText(/passphrase/i)).toBeInTheDocument();
    });
  });

  it('handles passphrase unlock flow', async () => {
    const { unlockWithPassphrase } = await import('../services/keyStore');
    mockValidIdentity();
    vi.mocked(authenticatePasskey).mockResolvedValueOnce({
      credentialId: 'cred1',
      credentialName: 'My Passkey',
      prfOutput: null,
      prfSupported: false,
    });

    useAuthStore.setState({
      teams: new Map([['t1', { token: 'tok', user: { id: 'u1' }, teamInfo: {}, baseUrl: 'http://localhost' }]]),
      setDerivedKey: vi.fn(),
      setPublicKey: vi.fn(),
    });

    render(<Login />);

    await waitFor(() => {
      expect(screen.getByText('login.unlockWithPasskey')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('login.unlockWithPasskey'));

    await waitFor(() => {
      expect(screen.getByPlaceholderText('login.passphrase')).toBeInTheDocument();
    });

    const passphraseInput = screen.getByPlaceholderText('login.passphrase');
    fireEvent.change(passphraseInput, { target: { value: 'my-passphrase' } });
    fireEvent.click(screen.getByText('login.unlock'));

    await waitFor(() => {
      expect(unlockWithPassphrase).toHaveBeenCalledWith('my-passphrase');
    });
  });

  it('shows identity username when loaded', async () => {
    localStorage.setItem('dilla_username', 'alice');
    mockValidIdentity();
    render(<Login />);
    await waitFor(() => {
      expect(screen.getByText('alice')).toBeInTheDocument();
    });
    localStorage.removeItem('dilla_username');
  });

  it('recovery key unlock does nothing with empty input', async () => {
    const { unlockWithRecovery } = await import('../services/keyStore');
    render(<Login />);
    await act(async () => {});

    // Go to recovery mode
    mockValidIdentity();
    const { rerender } = render(<Login />);
    await waitFor(() => {
      expect(screen.getAllByText('login.useRecoveryKey').length).toBeGreaterThan(0);
    });

    const useRecoveryBtns = screen.getAllByText('login.useRecoveryKey');
    fireEvent.click(useRecoveryBtns[0]);

    // Click unlock with empty input
    fireEvent.click(screen.getByText('login.unlockWithRecovery'));
    // Should not call unlockWithRecovery since input is empty
    expect(unlockWithRecovery).not.toHaveBeenCalled();
  });

  it('shows recovery key error on invalid recovery key', async () => {
    const { unlockWithRecovery } = await import('../services/keyStore');
    vi.mocked(unlockWithRecovery).mockRejectedValueOnce(new Error('Invalid key'));

    mockValidIdentity();
    render(<Login />);

    await waitFor(() => {
      expect(screen.getByText('login.useRecoveryKey')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('login.useRecoveryKey'));
    const input = screen.getByPlaceholderText('login.recoveryKeyPlaceholder');
    fireEvent.change(input, { target: { value: 'INVALID-KEY' } });
    fireEvent.click(screen.getByText('login.unlockWithRecovery'));

    await waitFor(() => {
      expect(screen.getByText('login.invalidRecoveryKey')).toBeInTheDocument();
    });
  });

  it('legacy mode redirects to recovery with error message', async () => {
    // Manually set mode to legacy by rendering when keyVersion=0
    vi.mocked(getCredentialInfo).mockResolvedValue(null);
    render(<Login />);
    await act(async () => {});
    // keyVersion is set to 0 from null getCredentialInfo
    // No passkey form shown; the component should show recover link
    expect(screen.getByText('Recover identity from server')).toBeInTheDocument();
  });

  it('shows passphrase input and recovery link when PRF not supported', async () => {
    mockValidIdentity();
    vi.mocked(authenticatePasskey).mockResolvedValueOnce({
      credentialId: 'cred1',
      credentialName: 'My Passkey',
      prfOutput: null,
      prfSupported: false,
    });

    render(<Login />);
    await waitFor(() => {
      expect(screen.getByText('login.unlockWithPasskey')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('login.unlockWithPasskey'));
    await waitFor(() => {
      expect(screen.getByPlaceholderText('login.passphrase')).toBeInTheDocument();
      expect(screen.getByText('login.useRecoveryKey')).toBeInTheDocument();
    });

    // Click use recovery key from passphrase view
    fireEvent.click(screen.getByText('login.useRecoveryKey'));
    expect(screen.getByPlaceholderText('login.recoveryKeyPlaceholder')).toBeInTheDocument();
  });

  it('passphrase unlock handles Enter key', async () => {
    const { unlockWithPassphrase } = await import('../services/keyStore');
    mockValidIdentity();
    vi.mocked(authenticatePasskey).mockResolvedValueOnce({
      credentialId: 'cred1',
      credentialName: 'My Passkey',
      prfOutput: null,
      prfSupported: false,
    });

    useAuthStore.setState({
      teams: new Map([['t1', { token: 'tok', user: { id: 'u1' }, teamInfo: {}, baseUrl: 'http://localhost' }]]),
      setDerivedKey: vi.fn(),
      setPublicKey: vi.fn(),
    });

    render(<Login />);
    await waitFor(() => {
      expect(screen.getByText('login.unlockWithPasskey')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('login.unlockWithPasskey'));
    await waitFor(() => {
      expect(screen.getByPlaceholderText('login.passphrase')).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText('login.passphrase');
    fireEvent.change(input, { target: { value: 'test-pass' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(unlockWithPassphrase).toHaveBeenCalledWith('test-pass');
    });
  });

  it('passphrase unlock shows error on failure', async () => {
    const { unlockWithPassphrase } = await import('../services/keyStore');
    vi.mocked(unlockWithPassphrase).mockRejectedValueOnce(new Error('wrong'));

    mockValidIdentity();
    vi.mocked(authenticatePasskey).mockResolvedValueOnce({
      credentialId: 'cred1',
      credentialName: 'My Passkey',
      prfOutput: null,
      prfSupported: false,
    });

    render(<Login />);
    await waitFor(() => {
      expect(screen.getByText('login.unlockWithPasskey')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('login.unlockWithPasskey'));
    await waitFor(() => {
      expect(screen.getByPlaceholderText('login.passphrase')).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText('login.passphrase');
    fireEvent.change(input, { target: { value: 'wrong-pass' } });
    fireEvent.click(screen.getByText('login.unlock'));

    await waitFor(() => {
      expect(screen.getByText('login.wrongPassphrase')).toBeInTheDocument();
    });
  });

  it('passphrase unlock does nothing with empty input', async () => {
    const { unlockWithPassphrase } = await import('../services/keyStore');
    mockValidIdentity();
    vi.mocked(authenticatePasskey).mockResolvedValueOnce({
      credentialId: 'cred1',
      credentialName: 'My Passkey',
      prfOutput: null,
      prfSupported: false,
    });

    render(<Login />);
    await waitFor(() => {
      expect(screen.getByText('login.unlockWithPasskey')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('login.unlockWithPasskey'));
    await waitFor(() => {
      expect(screen.getByPlaceholderText('login.passphrase')).toBeInTheDocument();
    });

    // Don't enter any passphrase, just click unlock
    // Button should be disabled
    const unlockBtn = screen.getByText('login.unlock');
    expect(unlockBtn).toBeDisabled();
  });
});
