import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import MentionAutocomplete from './MentionAutocomplete';

const users = [
  { id: 'u1', username: 'alice', avatarColor: '#abc' },
  { id: 'u2', username: 'bob' },
  { id: 'u3', username: 'charlie' },
];

const baseProps = {
  users,
  query: '',
  position: { top: 100, left: 50 },
  onSelect: vi.fn(),
  onClose: vi.fn(),
};

describe('MentionAutocomplete', () => {
  beforeEach(() => {
    cleanup();
    baseProps.onSelect = vi.fn();
    baseProps.onClose = vi.fn();
  });

  it('renders all users when query is empty', () => {
    render(<MentionAutocomplete {...baseProps} />);
    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(screen.getByText('bob')).toBeInTheDocument();
    expect(screen.getByText('charlie')).toBeInTheDocument();
  });

  it('filters users by query (case-insensitive)', () => {
    render(<MentionAutocomplete {...baseProps} query="AL" />);
    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(screen.queryByText('bob')).not.toBeInTheDocument();
  });

  it('renders nothing when no users match', () => {
    const { container } = render(<MentionAutocomplete {...baseProps} query="zzz" />);
    expect(container.innerHTML).toBe('');
  });

  it('calls onSelect when item clicked', () => {
    const onSelect = vi.fn();
    render(<MentionAutocomplete {...baseProps} onSelect={onSelect} />);
    fireEvent.click(screen.getByText('bob'));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ username: 'bob' }));
  });

  it('updates selected index on hover', () => {
    render(<MentionAutocomplete {...baseProps} />);
    const items = document.querySelectorAll('.mention-autocomplete-item');
    fireEvent.mouseEnter(items[2]);
    expect(items[2]).toHaveClass('selected');
  });

  it('navigates with ArrowDown / ArrowUp', () => {
    render(<MentionAutocomplete {...baseProps} />);
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    let items = document.querySelectorAll('.mention-autocomplete-item');
    expect(items[1]).toHaveClass('selected');
    fireEvent.keyDown(document, { key: 'ArrowUp' });
    items = document.querySelectorAll('.mention-autocomplete-item');
    expect(items[0]).toHaveClass('selected');
  });

  it('selects current item on Enter', () => {
    const onSelect = vi.fn();
    render(<MentionAutocomplete {...baseProps} onSelect={onSelect} />);
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ username: 'alice' }));
  });

  it('selects current item on Tab', () => {
    const onSelect = vi.fn();
    render(<MentionAutocomplete {...baseProps} onSelect={onSelect} />);
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(onSelect).toHaveBeenCalled();
  });

  it('calls onClose on Escape', () => {
    const onClose = vi.fn();
    render(<MentionAutocomplete {...baseProps} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('renders avatar with custom color when provided', () => {
    render(<MentionAutocomplete {...baseProps} />);
    const avatars = document.querySelectorAll('.mention-autocomplete-avatar');
    expect((avatars[0] as HTMLElement).style.background).toContain('rgb(170, 187, 204)');
  });
});
