import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import SafetyNumber from './SafetyNumber';
import { cryptoService } from '../../services/crypto';

vi.mock('../../services/crypto', () => ({
  cryptoService: {
    getSafetyNumber: vi.fn(),
  },
}));

const mockGetSafetyNumber = cryptoService.getSafetyNumber as ReturnType<typeof vi.fn>;

describe('SafetyNumber', () => {
  it('shows loading state initially', () => {
    mockGetSafetyNumber.mockReturnValue(new Promise(() => {})); // never resolves
    render(<SafetyNumber peerId="peer-1" peerPublicKey="pk-1" derivedKey="dk-1" />);
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
  });

  it('renders safety number when resolved', async () => {
    // 60 digits = 12 groups of 5
    const safetyNum = '123451234512345123451234512345123451234512345123451234512345';
    mockGetSafetyNumber.mockResolvedValue(safetyNum);

    render(<SafetyNumber peerId="peer-1" peerPublicKey="pk-1" derivedKey="dk-1" />);

    await waitFor(() => {
      expect(screen.getByText('Safety Number')).toBeInTheDocument();
      expect(screen.getAllByText(/12345 12345 12345 12345/).length).toBeGreaterThan(0);
    });
  });

  it('renders error state when crypto fails', async () => {
    mockGetSafetyNumber.mockRejectedValue(new Error('Crypto failed'));

    render(<SafetyNumber peerId="peer-1" peerPublicKey="pk-1" derivedKey="dk-1" />);

    await waitFor(() => {
      expect(screen.getByText('Failed to generate safety number')).toBeInTheDocument();
    });
  });

  it('renders explanation text', async () => {
    const safetyNum = '123451234512345123451234512345123451234512345123451234512345';
    mockGetSafetyNumber.mockResolvedValue(safetyNum);

    render(<SafetyNumber peerId="peer-1" peerPublicKey="pk-1" derivedKey="dk-1" />);

    await waitFor(() => {
      expect(screen.getByText(/Compare this number/)).toBeInTheDocument();
    });
  });

  it('calls getSafetyNumber with correct args', () => {
    mockGetSafetyNumber.mockReturnValue(new Promise(() => {}));

    render(<SafetyNumber peerId="peer-1" peerPublicKey="pk-1" derivedKey="dk-1" />);

    expect(mockGetSafetyNumber).toHaveBeenCalledWith('peer-1', 'pk-1', 'dk-1');
  });
});
