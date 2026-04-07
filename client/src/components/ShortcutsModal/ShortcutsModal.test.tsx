import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ShortcutsModal from './ShortcutsModal';

vi.mock('@tabler/icons-react', () => ({
  IconX: () => <span data-testid="Xmark" />,
}));

describe('ShortcutsModal', () => {
  it('renders the title', () => {
    render(<ShortcutsModal onClose={vi.fn()} />);
    expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument();
  });

  it('renders all shortcut rows', () => {
    const { container } = render(<ShortcutsModal onClose={vi.fn()} />);
    const rows = container.querySelectorAll('.shortcuts-row');
    expect(rows.length).toBe(6);
  });

  it('renders keyboard shortcut keys as kbd elements', () => {
    const { container } = render(<ShortcutsModal onClose={vi.fn()} />);
    const kbds = container.querySelectorAll('kbd.shortcuts-key');
    expect(kbds.length).toBe(6);
    // Check one of them
    const keys = Array.from(kbds).map((k) => k.textContent);
    expect(keys).toContain('Escape');
    expect(keys).toContain('Alt+\u2191/\u2193');
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();
    render(<ShortcutsModal onClose={onClose} />);
    const closeBtn = screen.getByTestId('Xmark').closest('button')!;
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when overlay is clicked', () => {
    const onClose = vi.fn();
    const { container } = render(<ShortcutsModal onClose={onClose} />);
    const overlay = container.querySelector('.dialog-backdrop')!;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not call onClose when modal content is clicked', () => {
    const onClose = vi.fn();
    const { container } = render(<ShortcutsModal onClose={onClose} />);
    const modal = container.querySelector('.shortcuts-modal')!;
    fireEvent.click(modal);
    expect(onClose).not.toHaveBeenCalled();
  });
});
