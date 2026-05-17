import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import AddPeerWizard from './AddPeerWizard';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AddPeerWizard', () => {
  it('renders nothing when closed', () => {
    render(<AddPeerWizard open={false} onClose={() => {}} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows token step initially', () => {
    render(<AddPeerWizard open onClose={() => {}} />);
    expect(screen.getByLabelText(/^token$/i)).toBeInTheDocument();
    expect(screen.getByText(/parse →/i)).toBeInTheDocument();
  });

  it('Parse advances to Confirm and shows peer URL', () => {
    render(<AddPeerWizard open onClose={() => {}} />);
    const textarea = screen.getByLabelText(/^token$/i);
    fireEvent.change(textarea, {
      target: { value: 'peer-token-abc@peer-1.dilla.example' },
    });
    fireEvent.click(screen.getByText(/parse →/i));
    expect(screen.getByText(/peer-1\.dilla\.example/i)).toBeInTheDocument();
    expect(screen.getByText(/begin handshake →/i)).toBeInTheDocument();
  });

  it('handshake step animates log lines and auto-advances to done', async () => {
    const onComplete = vi.fn();
    render(
      <AddPeerWizard open onClose={() => {}} onComplete={onComplete} />,
    );
    fireEvent.change(screen.getByLabelText(/^token$/i), {
      target: { value: 'token@peer.example' },
    });
    fireEvent.click(screen.getByText(/parse →/i));
    fireEvent.click(screen.getByText(/begin handshake →/i));

    // Step the timers through the handshake → done transition.
    // Advance in chunks so state updates between interval ticks flush.
    for (let i = 0; i < 30; i++) {
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
    }

    expect(screen.getByText(/peer is online/i)).toBeInTheDocument();
    fireEvent.click(screen.getByText(/^close$/i));
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'peer.example' }),
    );
  });

  it('Escape closes (when not mid-handshake)', () => {
    const onClose = vi.fn();
    render(<AddPeerWizard open onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('Cancel button closes', () => {
    const onClose = vi.fn();
    render(<AddPeerWizard open onClose={onClose} />);
    fireEvent.click(screen.getByText(/cancel/i));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
