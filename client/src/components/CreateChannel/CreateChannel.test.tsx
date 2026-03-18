import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import CreateChannel from './CreateChannel';

vi.mock('iconoir-react', () => ({
  Hashtag: () => <span data-testid="hashtag-icon" />,
  SoundHigh: () => <span data-testid="sound-icon" />,
}));

describe('CreateChannel', () => {
  it('has role="dialog" with aria-modal and aria-labelledby', () => {
    render(<CreateChannel teamId="t1" onClose={vi.fn()} existingCategories={[]} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby', 'create-channel-title');
  });

  it('has a heading matching the aria-labelledby id', () => {
    render(<CreateChannel teamId="t1" onClose={vi.fn()} existingCategories={[]} />);
    const heading = document.getElementById('create-channel-title');
    expect(heading).toBeInTheDocument();
    expect(heading?.tagName).toBe('H2');
  });

  it('has form labels linked to inputs via htmlFor/id', () => {
    render(<CreateChannel teamId="t1" onClose={vi.fn()} existingCategories={[]} />);
    const nameInput = document.getElementById('create-channel-name');
    expect(nameInput).toBeInTheDocument();
    expect(nameInput?.tagName).toBe('INPUT');

    const categorySelect = document.getElementById('create-channel-category');
    expect(categorySelect).toBeInTheDocument();
    expect(categorySelect?.tagName).toBe('SELECT');
  });
});
