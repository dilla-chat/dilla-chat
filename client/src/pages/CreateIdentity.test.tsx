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
});
