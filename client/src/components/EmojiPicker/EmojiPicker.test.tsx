import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import EmojiPicker from './EmojiPicker';

// Mock the emoji-picker-react library
vi.mock('emoji-picker-react', () => {
  const React = require('react');
  const MockPicker = ({ onEmojiClick }: { onEmojiClick: (data: { emoji: string }) => void }) => (
    <div data-testid="emoji-picker-inner">
      <button data-testid="emoji-smile" onClick={() => onEmojiClick({ emoji: '😊' })}>
        😊
      </button>
      <button data-testid="emoji-heart" onClick={() => onEmojiClick({ emoji: '❤️' })}>
        ❤️
      </button>
    </div>
  );
  return {
    default: MockPicker,
    Theme: { DARK: 'dark' },
  };
});

describe('EmojiPicker', () => {
  const onSelect = vi.fn();
  const onClose = vi.fn();

  beforeEach(() => {
    onSelect.mockClear();
    onClose.mockClear();
  });

  it('renders the picker', () => {
    render(<EmojiPicker onSelect={onSelect} onClose={onClose} />);
    expect(screen.getByTestId('emoji-picker-inner')).toBeInTheDocument();
  });

  it('calls onSelect when an emoji is clicked', () => {
    render(<EmojiPicker onSelect={onSelect} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('emoji-smile'));
    expect(onSelect).toHaveBeenCalledWith('😊');
  });

  it('calls onSelect with correct emoji for different emojis', () => {
    render(<EmojiPicker onSelect={onSelect} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('emoji-heart'));
    expect(onSelect).toHaveBeenCalledWith('❤️');
  });

  it('calls onClose when clicking outside the picker', () => {
    render(
      <div>
        <div data-testid="outside">Outside</div>
        <EmojiPicker onSelect={onSelect} onClose={onClose} />
      </div>,
    );
    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(onClose).toHaveBeenCalled();
  });

  it('does not call onClose when clicking inside the picker', () => {
    render(<EmojiPicker onSelect={onSelect} onClose={onClose} />);
    fireEvent.mouseDown(screen.getByTestId('emoji-picker-inner'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('has emoji-picker-container class', () => {
    const { container } = render(<EmojiPicker onSelect={onSelect} onClose={onClose} />);
    expect(container.querySelector('.emoji-picker-container')).toBeInTheDocument();
  });

  it('positions based on anchorRef when provided', () => {
    const anchorRef = { current: document.createElement('button') };
    // Mock getBoundingClientRect
    anchorRef.current.getBoundingClientRect = () => ({
      top: 100, left: 50, bottom: 120, right: 70, width: 20, height: 20, x: 50, y: 100, toJSON: () => {},
    });
    document.body.appendChild(anchorRef.current);

    render(<EmojiPicker onSelect={onSelect} onClose={onClose} anchorRef={anchorRef} />);
    // When anchorRef is provided, it portals to body with fixed positioning
    const picker = document.querySelector('.emoji-picker-container');
    expect(picker).toBeInTheDocument();
    expect(picker?.getAttribute('style')).toContain('fixed');

    document.body.removeChild(anchorRef.current);
  });

  it('uses absolute positioning when no anchorRef', () => {
    const { container } = render(<EmojiPicker onSelect={onSelect} onClose={onClose} />);
    const picker = container.querySelector('.emoji-picker-container');
    expect(picker?.getAttribute('style')).toContain('absolute');
  });
});
