import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import PasskeyManager from './PasskeyManager';
import { useAuthStore } from '../../stores/authStore';

vi.mock('../../services/webauthn', () => ({
  registerPasskey: vi.fn(),
  prfOutputToBase64: vi.fn(() => 'derived-key-base64'),
}));

vi.mock('../../services/keyStore', () => ({
  getCredentialInfo: vi.fn(() => Promise.resolve(null)),
  exportIdentityBlob: vi.fn(() => Promise.resolve(null)),
  encodeRecoveryKey: vi.fn(() => 'RECOVERY-KEY'),
  generateRecoveryKey: vi.fn(() => new Uint8Array(32)),
}));

describe('PasskeyManager', () => {
  beforeEach(() => {
    useAuthStore.setState({ derivedKey: 'test-key' });
  });

  it('renders nothing when credInfo is null', () => {
    const { container } = render(<PasskeyManager />);
    // getCredentialInfo returns null, so credInfo stays null
    expect(container.querySelector('.passkey-manager')).not.toBeInTheDocument();
  });

  it('renders passkey list when credentials are loaded', async () => {
    const { getCredentialInfo } = await import('../../services/keyStore');
    (getCredentialInfo as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      credentials: [
        { id: 'cred-1234567890ab', name: 'My Passkey', created_at: '2025-01-01' },
      ],
      prfSalt: new Uint8Array(32),
    });

    render(<PasskeyManager />);

    // Wait for credentials to load
    const item = await screen.findByText('My Passkey');
    expect(item).toBeInTheDocument();
    expect(screen.getByText('cred-1234567...')).toBeInTheDocument();
  });

  it('renders empty message when no credentials', async () => {
    const { getCredentialInfo } = await import('../../services/keyStore');
    (getCredentialInfo as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      credentials: [],
      prfSalt: new Uint8Array(32),
    });

    render(<PasskeyManager />);

    const empty = await screen.findByText('No passkeys registered');
    expect(empty).toBeInTheDocument();
  });

  it('renders action buttons when credentials loaded', async () => {
    const { getCredentialInfo } = await import('../../services/keyStore');
    (getCredentialInfo as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      credentials: [],
      prfSalt: new Uint8Array(32),
    });

    render(<PasskeyManager />);

    await screen.findByText('No passkeys registered');
    expect(screen.getByText('Add Another Passkey')).toBeInTheDocument();
    expect(screen.getByText('Regenerate Recovery Key')).toBeInTheDocument();
  });

  it('renders heading', async () => {
    const { getCredentialInfo } = await import('../../services/keyStore');
    (getCredentialInfo as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      credentials: [],
      prfSalt: new Uint8Array(32),
    });

    render(<PasskeyManager />);
    await screen.findByText('No passkeys registered');
    expect(screen.getByText('Passkey Management')).toBeInTheDocument();
  });
});
