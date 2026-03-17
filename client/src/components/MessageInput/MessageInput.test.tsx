import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MessageInput from './MessageInput';

// Mock iconoir-react
vi.mock('iconoir-react', () => ({
  Xmark: () => <span data-testid="xmark" />,
  Emoji: () => <span data-testid="emoji-icon" />,
  Hourglass: () => <span data-testid="hourglass" />,
  Page: () => <span data-testid="page" />,
  Link: () => <span data-testid="link-icon" />,
}));

// Mock EmojiPicker
vi.mock('../EmojiPicker/EmojiPicker', () => ({
  default: () => <div data-testid="emoji-picker" />,
}));

const defaultProps = {
  channelId: 'ch-1',
  channelName: 'general',
  currentUserId: 'u1',
  editingMessage: null,
  onSend: vi.fn(),
  onEdit: vi.fn(),
  onCancelEdit: vi.fn(),
  onTyping: vi.fn(),
};

function getTextarea() {
  return screen.getByRole('textbox');
}

describe('MessageInput', () => {
  it('renders a textarea', () => {
    render(<MessageInput {...defaultProps} />);
    expect(getTextarea()).toBeInTheDocument();
  });

  it('Enter submits the message', async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<MessageInput {...defaultProps} onSend={onSend} />);

    const textarea = getTextarea();
    await user.type(textarea, 'hello');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('hello');
  });

  it('Shift+Enter does not submit', async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<MessageInput {...defaultProps} onSend={onSend} />);

    const textarea = getTextarea();
    await user.type(textarea, 'hello');
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('shows editing banner when editingMessage is set', () => {
    render(
      <MessageInput
        {...defaultProps}
        editingMessage={{ id: 'm1', content: 'existing text' }}
      />,
    );
    expect(screen.getByText('Editing message')).toBeInTheDocument();
  });

  it('populates textarea with editing content', () => {
    render(
      <MessageInput
        {...defaultProps}
        editingMessage={{ id: 'm1', content: 'edit me' }}
      />,
    );
    expect(getTextarea()).toHaveValue('edit me');
  });
});
