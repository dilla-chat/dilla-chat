import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

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
  registerPasskey: vi.fn(),
  prfOutputToBase64: vi.fn(() => 'derived-key-b64'),
}));

vi.mock('../services/crypto', () => ({
  initCrypto: vi.fn(),
}));

vi.mock('../services/keyStore', () => ({
  createIdentity: vi.fn().mockResolvedValue({
    publicKeyB64: 'pubkey-b64',
    publicKeyHex: 'aabbccdd11223344eeff',
    recoveryKey: new Uint8Array(32),
    identity: { publicKeyBytes: new Uint8Array(32) },
  }),
  createIdentityWithPassphrase: vi.fn().mockResolvedValue({
    publicKeyB64: 'pubkey-b64',
    publicKeyHex: 'aabbccdd11223344eeff',
    recoveryKey: new Uint8Array(32),
    identity: { publicKeyBytes: new Uint8Array(32) },
  }),
  generatePrfSalt: vi.fn(() => new Uint8Array(32)),
  encodeRecoveryKey: vi.fn(() => 'DILLA-ABCD-EFGH-1234-5678'),
}));

vi.mock('../services/cryptoCore', () => ({
  fromBase64: vi.fn(() => new Uint8Array(32)),
}));

vi.mock('./PublicShell', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="public-shell">{children}</div>
  ),
}));

import CreateIdentity from './CreateIdentity';
import { useAuthStore } from '../stores/authStore';
import { registerPasskey } from '../services/webauthn';

describe('CreateIdentity', () => {
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
    sessionStorage.clear();
    localStorage.clear();
  });

  it('renders the identity creation form', () => {
    render(<CreateIdentity />);
    expect(screen.getByText('welcome.createIdentity')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Username')).toBeInTheDocument();
  });

  it('renders inside PublicShell', () => {
    render(<CreateIdentity />);
    expect(screen.getByTestId('public-shell')).toBeInTheDocument();
  });

  it('renders username input', () => {
    render(<CreateIdentity />);
    const input = screen.getByPlaceholderText('Username');
    expect(input).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'alice' } });
    expect(input).toHaveValue('alice');
  });

  it('disables create button when username is empty', () => {
    render(<CreateIdentity />);
    const btn = screen.getByText('identity.createWithPasskey');
    expect(btn).toBeDisabled();
  });

  it('enables create button when username and server are filled', () => {
    // isBrowser is true in jsdom (no __TAURI_INTERNALS__), so server is pre-filled
    render(<CreateIdentity />);
    const usernameInput = screen.getByPlaceholderText('Username');
    fireEvent.change(usernameInput, { target: { value: 'alice' } });

    const btn = screen.getByText('identity.createWithPasskey');
    expect(btn).not.toBeDisabled();
  });

  it('shows loading state during passkey registration', async () => {
    vi.mocked(registerPasskey).mockImplementation(
      () => new Promise(() => {}),
    );

    render(<CreateIdentity />);
    const usernameInput = screen.getByPlaceholderText('Username');
    fireEvent.change(usernameInput, { target: { value: 'alice' } });

    fireEvent.click(screen.getByText('identity.createWithPasskey'));

    await waitFor(() => {
      expect(
        screen.getByText('Opening browser for passkey setup...'),
      ).toBeInTheDocument();
    });
  });

  it('shows error on passkey registration failure', async () => {
    vi.mocked(registerPasskey).mockRejectedValueOnce(
      new Error('Registration cancelled'),
    );

    render(<CreateIdentity />);
    fireEvent.change(screen.getByPlaceholderText('Username'), {
      target: { value: 'alice' },
    });
    fireEvent.click(screen.getByText('identity.createWithPasskey'));

    await waitFor(() => {
      expect(screen.getByText(/Registration cancelled/)).toBeInTheDocument();
    });
  });

  it('shows recovery key after successful registration', async () => {
    vi.mocked(registerPasskey).mockResolvedValueOnce({
      credentialId: 'cred1',
      credentialName: 'My Passkey',
      prfOutput: new Uint8Array(32),
      prfSupported: true,
    });

    render(<CreateIdentity />);
    fireEvent.change(screen.getByPlaceholderText('Username'), {
      target: { value: 'alice' },
    });
    fireEvent.click(screen.getByText('identity.createWithPasskey'));

    await waitFor(() => {
      expect(screen.getByText('identity.recoveryKeyTitle')).toBeInTheDocument();
      expect(screen.getByText('DILLA-ABCD-EFGH-1234-5678')).toBeInTheDocument();
    });
  });

  it('shows copy button for recovery key', async () => {
    vi.mocked(registerPasskey).mockResolvedValueOnce({
      credentialId: 'cred1',
      credentialName: 'My Passkey',
      prfOutput: new Uint8Array(32),
      prfSupported: true,
    });

    render(<CreateIdentity />);
    fireEvent.change(screen.getByPlaceholderText('Username'), {
      target: { value: 'alice' },
    });
    fireEvent.click(screen.getByText('identity.createWithPasskey'));

    await waitFor(() => {
      expect(screen.getByText('identity.recoveryKeyCopy')).toBeInTheDocument();
    });
  });

  it('requires recovery key confirmation before continuing', async () => {
    vi.mocked(registerPasskey).mockResolvedValueOnce({
      credentialId: 'cred1',
      credentialName: 'My Passkey',
      prfOutput: new Uint8Array(32),
      prfSupported: true,
    });

    render(<CreateIdentity />);
    fireEvent.change(screen.getByPlaceholderText('Username'), {
      target: { value: 'alice' },
    });
    fireEvent.click(screen.getByText('identity.createWithPasskey'));

    await waitFor(() => {
      expect(screen.getByText('identity.recoveryKeyTitle')).toBeInTheDocument();
    });

    // Continue button should be disabled until checkbox is checked
    const continueBtn = screen.getByText('identity.continue');
    expect(continueBtn).toBeDisabled();

    // Check the confirmation checkbox
    const checkbox = screen.getByRole('checkbox');
    fireEvent.click(checkbox);

    expect(continueBtn).not.toBeDisabled();
  });

  it('shows done step with navigation options after confirming recovery', async () => {
    vi.mocked(registerPasskey).mockResolvedValueOnce({
      credentialId: 'cred1',
      credentialName: 'My Passkey',
      prfOutput: new Uint8Array(32),
      prfSupported: true,
    });

    render(<CreateIdentity />);
    fireEvent.change(screen.getByPlaceholderText('Username'), {
      target: { value: 'alice' },
    });
    fireEvent.click(screen.getByText('identity.createWithPasskey'));

    await waitFor(() => {
      expect(screen.getByText('identity.recoveryKeyTitle')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByText('identity.continue'));

    await waitFor(() => {
      expect(screen.getByText('identity.create')).toBeInTheDocument();
      expect(screen.getByText('auth.joinTeam')).toBeInTheDocument();
      expect(screen.getByText('setup.title')).toBeInTheDocument();
    });
  });

  it('navigates back when back button is clicked', () => {
    render(<CreateIdentity />);
    fireEvent.click(screen.getByText(/Back/));
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('shows passphrase form when PRF not supported', async () => {
    vi.mocked(registerPasskey).mockResolvedValueOnce({
      credentialId: 'cred1',
      credentialName: 'My Passkey',
      prfOutput: null,
      prfSupported: false,
    });

    render(<CreateIdentity />);
    fireEvent.change(screen.getByPlaceholderText('Username'), {
      target: { value: 'alice' },
    });
    fireEvent.click(screen.getByText('identity.createWithPasskey'));

    await waitFor(() => {
      expect(screen.getByText('Set a Passphrase')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Passphrase')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Confirm Passphrase')).toBeInTheDocument();
    });
  });

  it('validates passphrase minimum length', async () => {
    vi.mocked(registerPasskey).mockResolvedValueOnce({
      credentialId: 'cred1',
      credentialName: 'My Passkey',
      prfOutput: null,
      prfSupported: false,
    });

    render(<CreateIdentity />);
    fireEvent.change(screen.getByPlaceholderText('Username'), {
      target: { value: 'alice' },
    });
    fireEvent.click(screen.getByText('identity.createWithPasskey'));

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Passphrase')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText('Passphrase'), {
      target: { value: 'short' },
    });

    expect(screen.getByText('Minimum 12 characters')).toBeInTheDocument();
  });

  it('shows mismatch error when passphrases do not match', async () => {
    vi.mocked(registerPasskey).mockResolvedValueOnce({
      credentialId: 'cred1',
      credentialName: 'My Passkey',
      prfOutput: null,
      prfSupported: false,
    });

    render(<CreateIdentity />);
    fireEvent.change(screen.getByPlaceholderText('Username'), { target: { value: 'alice' } });
    fireEvent.click(screen.getByText('identity.createWithPasskey'));

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Passphrase')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText('Passphrase'), { target: { value: 'longpassphrase1' } });
    fireEvent.change(screen.getByPlaceholderText('Confirm Passphrase'), { target: { value: 'longpassphrase2' } });

    expect(screen.getByText('identity.passphraseNoMatch')).toBeInTheDocument();
  });

  it('disables continue button when passphrases do not match', async () => {
    vi.mocked(registerPasskey).mockResolvedValueOnce({
      credentialId: 'cred1',
      credentialName: 'My Passkey',
      prfOutput: null,
      prfSupported: false,
    });

    render(<CreateIdentity />);
    fireEvent.change(screen.getByPlaceholderText('Username'), { target: { value: 'alice' } });
    fireEvent.click(screen.getByText('identity.createWithPasskey'));

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Passphrase')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText('Passphrase'), { target: { value: 'longpassphrase1' } });
    fireEvent.change(screen.getByPlaceholderText('Confirm Passphrase'), { target: { value: 'different' } });

    const continueBtn = screen.getByText('identity.continue');
    expect(continueBtn).toBeDisabled();
  });

  it('submits passphrase and shows recovery key', async () => {
    vi.mocked(registerPasskey).mockResolvedValueOnce({
      credentialId: 'cred1',
      credentialName: 'My Passkey',
      prfOutput: null,
      prfSupported: false,
    });

    render(<CreateIdentity />);
    fireEvent.change(screen.getByPlaceholderText('Username'), { target: { value: 'alice' } });
    fireEvent.click(screen.getByText('identity.createWithPasskey'));

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Passphrase')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText('Passphrase'), { target: { value: 'longpassphrase1' } });
    fireEvent.change(screen.getByPlaceholderText('Confirm Passphrase'), { target: { value: 'longpassphrase1' } });
    fireEvent.click(screen.getByText('identity.continue'));

    await waitFor(() => {
      expect(screen.getByText('identity.recoveryKeyTitle')).toBeInTheDocument();
    });
  });

  it('copies recovery key on button click', async () => {
    const clipboardWriteText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: clipboardWriteText } });

    vi.mocked(registerPasskey).mockResolvedValueOnce({
      credentialId: 'cred1',
      credentialName: 'My Passkey',
      prfOutput: new Uint8Array(32),
      prfSupported: true,
    });

    render(<CreateIdentity />);
    fireEvent.change(screen.getByPlaceholderText('Username'), { target: { value: 'alice' } });
    fireEvent.click(screen.getByText('identity.createWithPasskey'));

    await waitFor(() => {
      expect(screen.getByText('identity.recoveryKeyCopy')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('identity.recoveryKeyCopy'));

    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledWith('DILLA-ABCD-EFGH-1234-5678');
    });
  });

  it('navigates to join path on done step with pending invite', async () => {
    sessionStorage.setItem('pendingInviteToken', 'invite-abc');

    vi.mocked(registerPasskey).mockResolvedValueOnce({
      credentialId: 'cred1',
      credentialName: 'My Passkey',
      prfOutput: new Uint8Array(32),
      prfSupported: true,
    });

    render(<CreateIdentity />);
    fireEvent.change(screen.getByPlaceholderText('Username'), { target: { value: 'alice' } });
    fireEvent.click(screen.getByText('identity.createWithPasskey'));

    await waitFor(() => {
      expect(screen.getByText('identity.recoveryKeyTitle')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByText('identity.continue'));

    await waitFor(() => {
      expect(screen.getByText('auth.joinTeam')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('auth.joinTeam'));
    expect(mockNavigate).toHaveBeenCalledWith('/join/invite-abc');
  });

  it('shows skip for now button on done step', async () => {
    vi.mocked(registerPasskey).mockResolvedValueOnce({
      credentialId: 'cred1',
      credentialName: 'My Passkey',
      prfOutput: new Uint8Array(32),
      prfSupported: true,
    });

    render(<CreateIdentity />);
    fireEvent.change(screen.getByPlaceholderText('Username'), { target: { value: 'alice' } });
    fireEvent.click(screen.getByText('identity.createWithPasskey'));

    await waitFor(() => {
      expect(screen.getByText('identity.recoveryKeyTitle')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByText('identity.continue'));

    await waitFor(() => {
      expect(screen.getByText('Skip for now')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Skip for now'));
    expect(mockNavigate).toHaveBeenCalledWith('/app');
  });

  it('handles Enter key on username to trigger creation', async () => {
    vi.mocked(registerPasskey).mockImplementation(() => new Promise(() => {}));

    render(<CreateIdentity />);
    const usernameInput = screen.getByPlaceholderText('Username');
    fireEvent.change(usernameInput, { target: { value: 'alice' } });
    fireEvent.keyDown(usernameInput, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByText('Opening browser for passkey setup...')).toBeInTheDocument();
    });
  });

  it('stores username in localStorage', async () => {
    vi.mocked(registerPasskey).mockImplementation(() => new Promise(() => {}));

    render(<CreateIdentity />);
    fireEvent.change(screen.getByPlaceholderText('Username'), { target: { value: 'myuser' } });
    fireEvent.click(screen.getByText('identity.createWithPasskey'));

    await waitFor(() => {
      expect(localStorage.getItem('dilla_username')).toBe('myuser');
    });
  });

  it('navigates to setup on done step', async () => {
    vi.mocked(registerPasskey).mockResolvedValueOnce({
      credentialId: 'cred1',
      credentialName: 'My Passkey',
      prfOutput: new Uint8Array(32),
      prfSupported: true,
    });

    render(<CreateIdentity />);
    fireEvent.change(screen.getByPlaceholderText('Username'), { target: { value: 'alice' } });
    fireEvent.click(screen.getByText('identity.createWithPasskey'));

    await waitFor(() => {
      expect(screen.getByText('identity.recoveryKeyTitle')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByText('identity.continue'));

    await waitFor(() => {
      expect(screen.getByText('setup.title')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('setup.title'));
    expect(mockNavigate).toHaveBeenCalledWith('/setup');
  });

  it('handles passphrase submit error', async () => {
    const { createIdentityWithPassphrase } = await import('../services/keyStore');
    vi.mocked(createIdentityWithPassphrase).mockRejectedValueOnce(new Error('Passphrase error'));

    vi.mocked(registerPasskey).mockResolvedValueOnce({
      credentialId: 'cred1',
      credentialName: 'My Passkey',
      prfOutput: null,
      prfSupported: false,
    });

    render(<CreateIdentity />);
    fireEvent.change(screen.getByPlaceholderText('Username'), { target: { value: 'alice' } });
    fireEvent.click(screen.getByText('identity.createWithPasskey'));

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Passphrase')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText('Passphrase'), { target: { value: 'longpassphrase1' } });
    fireEvent.change(screen.getByPlaceholderText('Confirm Passphrase'), { target: { value: 'longpassphrase1' } });
    fireEvent.click(screen.getByText('identity.continue'));

    await waitFor(() => {
      expect(screen.getByText(/Passphrase error/)).toBeInTheDocument();
    });
  });

  it('handles Enter key on confirm passphrase field', async () => {
    const { createIdentityWithPassphrase } = await import('../services/keyStore');

    vi.mocked(registerPasskey).mockResolvedValueOnce({
      credentialId: 'cred1',
      credentialName: 'My Passkey',
      prfOutput: null,
      prfSupported: false,
    });

    render(<CreateIdentity />);
    fireEvent.change(screen.getByPlaceholderText('Username'), { target: { value: 'alice' } });
    fireEvent.click(screen.getByText('identity.createWithPasskey'));

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Passphrase')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText('Passphrase'), { target: { value: 'longpassphrase1' } });
    fireEvent.change(screen.getByPlaceholderText('Confirm Passphrase'), { target: { value: 'longpassphrase1' } });
    fireEvent.keyDown(screen.getByPlaceholderText('Confirm Passphrase'), { key: 'Enter' });

    await waitFor(() => {
      expect(createIdentityWithPassphrase).toHaveBeenCalled();
    });
  });

  it('does not show server address input in browser mode', () => {
    render(<CreateIdentity />);
    expect(screen.queryByPlaceholderText(/Server address/)).not.toBeInTheDocument();
  });

  it('does nothing when handleCreateWithPasskey called without username', async () => {
    render(<CreateIdentity />);
    // Username is empty, button should be disabled
    const btn = screen.getByText('identity.createWithPasskey');
    expect(btn).toBeDisabled();
  });

  it('clipboard copy failure does not crash', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('clipboard fail')) } });

    vi.mocked(registerPasskey).mockResolvedValueOnce({
      credentialId: 'cred1',
      credentialName: 'My Passkey',
      prfOutput: new Uint8Array(32),
      prfSupported: true,
    });

    render(<CreateIdentity />);
    fireEvent.change(screen.getByPlaceholderText('Username'), { target: { value: 'alice' } });
    fireEvent.click(screen.getByText('identity.createWithPasskey'));

    await waitFor(() => {
      expect(screen.getByText('identity.recoveryKeyCopy')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('identity.recoveryKeyCopy'));
    // Should not crash
  });

  it('does not submit passphrase if too short', async () => {
    const { createIdentityWithPassphrase } = await import('../services/keyStore');

    vi.mocked(registerPasskey).mockResolvedValueOnce({
      credentialId: 'cred1',
      credentialName: 'My Passkey',
      prfOutput: null,
      prfSupported: false,
    });

    render(<CreateIdentity />);
    fireEvent.change(screen.getByPlaceholderText('Username'), { target: { value: 'alice' } });
    fireEvent.click(screen.getByText('identity.createWithPasskey'));

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Passphrase')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText('Passphrase'), { target: { value: 'short' } });
    fireEvent.change(screen.getByPlaceholderText('Confirm Passphrase'), { target: { value: 'short' } });

    // Continue button should be disabled
    const continueBtn = screen.getByText('identity.continue');
    expect(continueBtn).toBeDisabled();
  });

  it('reads username from localStorage', () => {
    localStorage.setItem('dilla_username', 'saveduser');
    render(<CreateIdentity />);
    const input = screen.getByPlaceholderText('Username');
    expect(input).toHaveValue('saveduser');
  });

  it('shows server address input in Tauri mode and allows typing', () => {
    // Simulate Tauri environment
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    render(<CreateIdentity />);
    const serverInput = screen.getByPlaceholderText('Server address (e.g. dilla.example.com)');
    expect(serverInput).toBeInTheDocument();
    fireEvent.change(serverInput, { target: { value: 'my.server.com' } });
    expect(serverInput).toHaveValue('my.server.com');
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });
});
