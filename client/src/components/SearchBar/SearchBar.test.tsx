import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SearchBar from './SearchBar';

// Mock iconoir-react
vi.mock('iconoir-react', () => ({
  Search: () => <span data-testid="search-icon" />,
  Xmark: () => <span data-testid="xmark-icon" />,
}));

describe('SearchBar', () => {
  it('renders input with placeholder', () => {
    render(<SearchBar />);
    expect(screen.getByPlaceholderText('Search messages...')).toBeInTheDocument();
  });

  it('typing updates the input value', async () => {
    const user = userEvent.setup();
    render(<SearchBar />);
    const input = screen.getByPlaceholderText('Search messages...');
    await user.type(input, 'hello');
    expect(input).toHaveValue('hello');
  });

  it('Escape clears the input', async () => {
    const user = userEvent.setup();
    render(<SearchBar />);
    const input = screen.getByPlaceholderText('Search messages...');
    await user.type(input, 'test');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input).toHaveValue('');
  });
});
