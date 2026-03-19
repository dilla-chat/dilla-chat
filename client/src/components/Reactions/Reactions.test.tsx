import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Reactions from './Reactions';
import type { Reaction } from '../../stores/messageStore';

// Mock iconoir-react and EmojiPicker
vi.mock('iconoir-react', () => ({
  Plus: () => <span data-testid="plus-icon" />,
}));
vi.mock('../EmojiPicker/EmojiPicker', () => ({
  default: ({ onSelect, onClose }: { onSelect: (emoji: string) => void; onClose: () => void }) => (
    <div data-testid="emoji-picker">
      <button data-testid="emoji-select" onClick={() => onSelect('😀')}>Select</button>
      <button data-testid="emoji-close" onClick={onClose}>Close</button>
    </div>
  ),
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

  it('does not highlight reaction when user has not reacted', () => {
    render(
      <Reactions
        reactions={[{ emoji: '😊', users: ['u3'], count: 1 }]}
        currentUserId="u1"
        onToggleReaction={vi.fn()}
        onAddReaction={vi.fn()}
      />,
    );
    const btn = screen.getByText('😊').closest('button')!;
    expect(btn.className).not.toContain('reaction-chip-active');
  });

  it('shows add reaction button', () => {
    render(
      <Reactions
        reactions={reactions}
        currentUserId="u1"
        onToggleReaction={vi.fn()}
        onAddReaction={vi.fn()}
      />,
    );
    expect(screen.getByTitle('Add Reaction')).toBeInTheDocument();
  });

  it('opens emoji picker when add button is clicked', () => {
    render(
      <Reactions
        reactions={reactions}
        currentUserId="u1"
        onToggleReaction={vi.fn()}
        onAddReaction={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTitle('Add Reaction'));
    expect(screen.getByTestId('emoji-picker')).toBeInTheDocument();
  });

  it('closes emoji picker when add button is clicked again', () => {
    render(
      <Reactions
        reactions={reactions}
        currentUserId="u1"
        onToggleReaction={vi.fn()}
        onAddReaction={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTitle('Add Reaction'));
    expect(screen.getByTestId('emoji-picker')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Add Reaction'));
    expect(screen.queryByTestId('emoji-picker')).not.toBeInTheDocument();
  });

  it('shows reaction tooltip on hover', () => {
    render(
      <Reactions
        reactions={reactions}
        currentUserId="u1"
        onToggleReaction={vi.fn()}
        onAddReaction={vi.fn()}
      />,
    );
    const btn = screen.getByText('🎉').closest('button')!;
    fireEvent.mouseEnter(btn);
    expect(screen.getByText('u1, u2')).toBeInTheDocument();
    fireEvent.mouseLeave(btn);
    expect(screen.queryByText('u1, u2')).not.toBeInTheDocument();
  });

  it('shows truncated tooltip for many users', () => {
    const manyReactions = [{ emoji: '👍', users: ['u1', 'u2', 'u3', 'u4', 'u5'], count: 5 }];
    render(
      <Reactions
        reactions={manyReactions}
        currentUserId="u1"
        onToggleReaction={vi.fn()}
        onAddReaction={vi.fn()}
      />,
    );
    const btn = screen.getByText('👍').closest('button')!;
    fireEvent.mouseEnter(btn);
    expect(screen.getByText('u1, u2, u3 +2')).toBeInTheDocument();
  });

  it('shows reaction count correctly', () => {
    render(
      <Reactions
        reactions={[{ emoji: '🔥', users: ['u1', 'u2', 'u3'], count: 3 }]}
        currentUserId="u1"
        onToggleReaction={vi.fn()}
        onAddReaction={vi.fn()}
      />,
    );
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('calls onAddReaction and closes picker when emoji is selected', () => {
    const onAddReaction = vi.fn();
    render(
      <Reactions
        reactions={reactions}
        currentUserId="u1"
        onToggleReaction={vi.fn()}
        onAddReaction={onAddReaction}
      />,
    );
    fireEvent.click(screen.getByTitle('Add Reaction'));
    expect(screen.getByTestId('emoji-picker')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('emoji-select'));
    expect(onAddReaction).toHaveBeenCalledWith('😀');
    // Picker should close after selection
    expect(screen.queryByTestId('emoji-picker')).not.toBeInTheDocument();
  });

  it('closes emoji picker via close button', () => {
    render(
      <Reactions
        reactions={reactions}
        currentUserId="u1"
        onToggleReaction={vi.fn()}
        onAddReaction={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTitle('Add Reaction'));
    expect(screen.getByTestId('emoji-picker')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('emoji-close'));
    expect(screen.queryByTestId('emoji-picker')).not.toBeInTheDocument();
  });
});
