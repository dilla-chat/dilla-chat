import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Reactions from './Reactions';
import type { Reaction } from '../../stores/messageStore';

// Mock iconoir-react and EmojiPicker
vi.mock('iconoir-react', () => ({
  Plus: () => <span data-testid="plus-icon" />,
}));
vi.mock('../EmojiPicker/EmojiPicker', () => ({
  default: () => <div data-testid="emoji-picker" />,
}));

const reactions: Reaction[] = [
  { emoji: '🎉', users: ['u1', 'u2'], count: 2 },
  { emoji: '❤️', users: ['u1'], count: 1 },
];

describe('Reactions', () => {
  it('renders emoji and count', () => {
    render(
      <Reactions
        reactions={reactions}
        currentUserId="u1"
        onToggleReaction={vi.fn()}
        onAddReaction={vi.fn()}
      />,
    );
    expect(screen.getByText('🎉')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('❤️')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('click calls onToggleReaction', () => {
    const onToggle = vi.fn();
    render(
      <Reactions
        reactions={reactions}
        currentUserId="u1"
        onToggleReaction={onToggle}
        onAddReaction={vi.fn()}
      />,
    );
    // Click the first reaction chip (contains 🎉)
    fireEvent.click(screen.getByText('🎉').closest('button')!);
    expect(onToggle).toHaveBeenCalledWith('🎉');
  });

  it('returns null when no reactions', () => {
    const { container } = render(
      <Reactions
        reactions={[]}
        currentUserId="u1"
        onToggleReaction={vi.fn()}
        onAddReaction={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('highlights active reaction for current user', () => {
    render(
      <Reactions
        reactions={reactions}
        currentUserId="u1"
        onToggleReaction={vi.fn()}
        onAddReaction={vi.fn()}
      />,
    );
    const partyButton = screen.getByText('🎉').closest('button')!;
    expect(partyButton.className).toContain('reaction-chip-active');
  });
});
