import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MessageInput from './MessageInput';

// Mock @tabler/icons-react
vi.mock('@tabler/icons-react', () => ({
  IconX: () => <span data-testid="xmark" />,
  IconMoodSmile: () => <span data-testid="emoji-icon" />,
  IconHourglass: () => <span data-testid="hourglass" />,
  IconFile: () => <span data-testid="page" />,
  IconLink: () => <span data-testid="link-icon" />,
}));

// Mock EmojiPicker - call onSelect when a button inside is clicked
vi.mock('../EmojiPicker/EmojiPicker', () => ({
  default: ({ onSelect, onClose }: { onSelect: (emoji: string) => void; onClose: () => void }) => (
    <div data-testid="emoji-picker">
      <button data-testid="emoji-select-btn" onClick={() => onSelect('\u{1F600}')}>Pick</button>
      <button data-testid="emoji-close-btn" onClick={onClose}>Close Picker</button>
    </div>
  ),
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

  it('calls onEdit when pressing Enter in edit mode', async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();
    render(
      <MessageInput
        {...defaultProps}
        onEdit={onEdit}
        editingMessage={{ id: 'm1', content: 'edit me' }}
      />,
    );
    const textarea = getTextarea();
    await user.clear(textarea);
    await user.type(textarea, 'updated');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onEdit).toHaveBeenCalledWith('m1', 'updated');
  });

  it('calls onCancelEdit and clears value when pressing Escape in edit mode', async () => {
    const onCancelEdit = vi.fn();
    render(
      <MessageInput
        {...defaultProps}
        onCancelEdit={onCancelEdit}
        editingMessage={{ id: 'm1', content: 'edit me' }}
      />,
    );
    const textarea = getTextarea();
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(onCancelEdit).toHaveBeenCalled();
  });

  it('calls onCancelEdit when clicking cancel button', () => {
    const onCancelEdit = vi.fn();
    render(
      <MessageInput
        {...defaultProps}
        onCancelEdit={onCancelEdit}
        editingMessage={{ id: 'm1', content: 'edit me' }}
      />,
    );
    fireEvent.click(screen.getByText(/Cancel/));
    expect(onCancelEdit).toHaveBeenCalled();
  });

  it('does not submit when textarea is empty', () => {
    const onSend = vi.fn();
    render(<MessageInput {...defaultProps} onSend={onSend} />);
    const textarea = getTextarea();
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('sends typing indicator on keypress with throttle', async () => {
    const onTyping = vi.fn();
    const user = userEvent.setup();
    render(<MessageInput {...defaultProps} onTyping={onTyping} />);
    const textarea = getTextarea();
    await user.type(textarea, 'a');
    expect(onTyping).toHaveBeenCalledTimes(1);
  });

  it('renders formatting toolbar buttons', () => {
    render(<MessageInput {...defaultProps} />);
    expect(screen.getByTitle('Bold (Ctrl+B)')).toBeInTheDocument();
    expect(screen.getByTitle('Italic (Ctrl+I)')).toBeInTheDocument();
    expect(screen.getByTitle('Strikethrough (Ctrl+Shift+X)')).toBeInTheDocument();
    expect(screen.getByTitle('Link')).toBeInTheDocument();
    expect(screen.getByTitle('Ordered List')).toBeInTheDocument();
    expect(screen.getByTitle('Bulleted List')).toBeInTheDocument();
    expect(screen.getByTitle('Blockquote')).toBeInTheDocument();
    expect(screen.getByTitle('Code (Ctrl+E)')).toBeInTheDocument();
    expect(screen.getByTitle('Code Block')).toBeInTheDocument();
  });

  it('applies bold formatting when toolbar button is clicked', async () => {
    render(<MessageInput {...defaultProps} />);
    fireEvent.click(screen.getByTitle('Bold (Ctrl+B)'));
    expect(getTextarea()).toHaveValue('**bold text**');
  });

  it('applies italic formatting when toolbar button is clicked', () => {
    render(<MessageInput {...defaultProps} />);
    fireEvent.click(screen.getByTitle('Italic (Ctrl+I)'));
    expect(getTextarea()).toHaveValue('_italic text_');
  });

  it('applies strikethrough formatting', () => {
    render(<MessageInput {...defaultProps} />);
    fireEvent.click(screen.getByTitle('Strikethrough (Ctrl+Shift+X)'));
    expect(getTextarea()).toHaveValue('~~strikethrough~~');
  });

  it('applies code formatting', () => {
    render(<MessageInput {...defaultProps} />);
    fireEvent.click(screen.getByTitle('Code (Ctrl+E)'));
    expect(getTextarea()).toHaveValue('`code`');
  });

  it('applies code block formatting', () => {
    render(<MessageInput {...defaultProps} />);
    fireEvent.click(screen.getByTitle('Code Block'));
    expect(getTextarea()).toHaveValue('```\ncode\n```');
  });

  it('applies link formatting', () => {
    render(<MessageInput {...defaultProps} />);
    fireEvent.click(screen.getByTitle('Link'));
    expect(getTextarea()).toHaveValue('[link text](url)');
  });

  it('applies ordered list formatting', () => {
    render(<MessageInput {...defaultProps} />);
    fireEvent.click(screen.getByTitle('Ordered List'));
    expect(getTextarea()).toHaveValue('1. ');
  });

  it('applies unordered list formatting', () => {
    render(<MessageInput {...defaultProps} />);
    fireEvent.click(screen.getByTitle('Bulleted List'));
    expect(getTextarea()).toHaveValue('- ');
  });

  it('applies blockquote formatting', () => {
    render(<MessageInput {...defaultProps} />);
    fireEvent.click(screen.getByTitle('Blockquote'));
    expect(getTextarea()).toHaveValue('> ');
  });

  it('toggles emoji picker when emoji button is clicked', () => {
    render(<MessageInput {...defaultProps} />);
    fireEvent.click(screen.getByTitle('Emoji'));
    expect(screen.getByTestId('emoji-picker')).toBeInTheDocument();
  });

  it('renders attach file button', () => {
    render(<MessageInput {...defaultProps} />);
    expect(screen.getByTitle('Attach File')).toBeInTheDocument();
  });

  it('renders send button', () => {
    render(<MessageInput {...defaultProps} />);
    expect(screen.getByTitle('Send Message')).toBeInTheDocument();
  });

  it('send button is disabled when no content', () => {
    render(<MessageInput {...defaultProps} />);
    expect(screen.getByTitle('Send Message')).toBeDisabled();
  });

  it('send button is enabled when there is content', async () => {
    const user = userEvent.setup();
    render(<MessageInput {...defaultProps} />);
    await user.type(getTextarea(), 'hello');
    expect(screen.getByTitle('Send Message')).not.toBeDisabled();
  });

  it('clicking send button sends the message', async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<MessageInput {...defaultProps} onSend={onSend} />);
    await user.type(getTextarea(), 'hello');
    fireEvent.click(screen.getByTitle('Send Message'));
    expect(onSend).toHaveBeenCalledWith('hello');
  });

  it('handles file drop', () => {
    render(<MessageInput {...defaultProps} />);
    const wrapper = document.querySelector('.message-input-wrapper')!;
    fireEvent.dragOver(wrapper);
    expect(document.querySelector('.message-input-dragging')).toBeInTheDocument();
    fireEvent.dragLeave(wrapper);
    expect(document.querySelector('.message-input-dragging')).not.toBeInTheDocument();
  });

  it('shows file previews for pending files', () => {
    const file = new File(['data'], 'test.txt', { type: 'text/plain' });
    render(<MessageInput {...defaultProps} />);
    const wrapper = document.querySelector('.message-input-wrapper')!;
    fireEvent.drop(wrapper, { dataTransfer: { files: [file] } });
    expect(screen.getByText('test.txt')).toBeInTheDocument();
  });

  it('removes a pending file when remove button is clicked', () => {
    const file = new File(['data'], 'test.txt', { type: 'text/plain' });
    render(<MessageInput {...defaultProps} />);
    const wrapper = document.querySelector('.message-input-wrapper')!;
    fireEvent.drop(wrapper, { dataTransfer: { files: [file] } });
    expect(screen.getByText('test.txt')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Remove'));
    expect(screen.queryByText('test.txt')).not.toBeInTheDocument();
  });

  it('displays file size in correct format', () => {
    const file = new File(['x'.repeat(500)], 'small.txt', { type: 'text/plain' });
    render(<MessageInput {...defaultProps} />);
    const wrapper = document.querySelector('.message-input-wrapper')!;
    fireEvent.drop(wrapper, { dataTransfer: { files: [file] } });
    expect(screen.getByText('500 B')).toBeInTheDocument();
  });

  it('uses custom placeholder when provided', () => {
    render(<MessageInput {...defaultProps} placeholder="Custom placeholder" />);
    expect(screen.getByPlaceholderText('Custom placeholder')).toBeInTheDocument();
  });

  it('uses default placeholder with channel name', () => {
    render(<MessageInput {...defaultProps} />);
    expect(screen.getByPlaceholderText('Message ~{{channel}}')).toBeInTheDocument();
  });

  it('uploads files and sends with attachments', async () => {
    const mockAttachment = { id: 'att-1', message_id: 'msg-1', filename: 'test.txt', content_type: 'text/plain', size: 4, url: '/test.txt' };
    const onUploadFile = vi.fn().mockResolvedValue(mockAttachment);
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<MessageInput {...defaultProps} onSend={onSend} onUploadFile={onUploadFile} />);

    // Add a file via drop
    const file = new File(['data'], 'test.txt', { type: 'text/plain' });
    const wrapper = document.querySelector('.message-input-wrapper')!;
    fireEvent.drop(wrapper, { dataTransfer: { files: [file] } });

    await user.type(getTextarea(), 'with file');
    fireEvent.keyDown(getTextarea(), { key: 'Enter' });

    // Wait for async upload
    await vi.waitFor(() => {
      expect(onUploadFile).toHaveBeenCalledWith(file);
      expect(onSend).toHaveBeenCalledWith('with file', [mockAttachment]);
    });
  });

  it('shows upload error when upload fails', async () => {
    const onUploadFile = vi.fn().mockRejectedValue(new Error('fail'));
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<MessageInput {...defaultProps} onSend={onSend} onUploadFile={onUploadFile} />);

    const file = new File(['data'], 'test.txt', { type: 'text/plain' });
    const wrapper = document.querySelector('.message-input-wrapper')!;
    fireEvent.drop(wrapper, { dataTransfer: { files: [file] } });

    await user.type(getTextarea(), 'msg');
    fireEvent.keyDown(getTextarea(), { key: 'Enter' });

    await vi.waitFor(() => {
      expect(screen.getByText('Upload failed')).toBeInTheDocument();
    });
  });

  it('applies bold formatting via keyboard shortcut', async () => {
    render(<MessageInput {...defaultProps} />);
    const textarea = getTextarea();
    fireEvent.keyDown(textarea, { key: 'b', ctrlKey: true });
    expect(textarea).toHaveValue('**bold text**');
  });

  it('applies italic formatting via keyboard shortcut', () => {
    render(<MessageInput {...defaultProps} />);
    const textarea = getTextarea();
    fireEvent.keyDown(textarea, { key: 'i', ctrlKey: true });
    expect(textarea).toHaveValue('_italic text_');
  });

  it('applies code formatting via keyboard shortcut', () => {
    render(<MessageInput {...defaultProps} />);
    const textarea = getTextarea();
    fireEvent.keyDown(textarea, { key: 'e', ctrlKey: true });
    expect(textarea).toHaveValue('`code`');
  });

  it('applies strikethrough formatting via keyboard shortcut', () => {
    render(<MessageInput {...defaultProps} />);
    const textarea = getTextarea();
    fireEvent.keyDown(textarea, { key: 'x', ctrlKey: true, shiftKey: true });
    expect(textarea).toHaveValue('~~strikethrough~~');
  });

  it('displays file size in KB format', () => {
    const file = new File(['x'.repeat(2048)], 'medium.txt', { type: 'text/plain' });
    Object.defineProperty(file, 'size', { value: 2048 });
    render(<MessageInput {...defaultProps} />);
    const wrapper = document.querySelector('.message-input-wrapper')!;
    fireEvent.drop(wrapper, { dataTransfer: { files: [file] } });
    expect(screen.getByText('2.0 KB')).toBeInTheDocument();
  });

  it('displays file size in MB format', () => {
    const file = new File(['x'], 'large.bin', { type: 'application/octet-stream' });
    Object.defineProperty(file, 'size', { value: 2 * 1024 * 1024 });
    render(<MessageInput {...defaultProps} />);
    const wrapper = document.querySelector('.message-input-wrapper')!;
    fireEvent.drop(wrapper, { dataTransfer: { files: [file] } });
    expect(screen.getByText('2.0 MB')).toBeInTheDocument();
  });

  it('adds files via file input change handler', () => {
    render(<MessageInput {...defaultProps} />);
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['data'], 'input-file.txt', { type: 'text/plain' });
    fireEvent.change(fileInput, { target: { files: [file] } });
    expect(screen.getByText('input-file.txt')).toBeInTheDocument();
  });

  it('shows image preview for image files', () => {
    const file = new File(['img'], 'photo.png', { type: 'image/png' });
    render(<MessageInput {...defaultProps} />);
    const wrapper = document.querySelector('.message-input-wrapper')!;
    fireEvent.drop(wrapper, { dataTransfer: { files: [file] } });
    const img = document.querySelector('.file-preview-thumb');
    expect(img).toBeInTheDocument();
  });

  it('shows page icon for non-image files', () => {
    const file = new File(['data'], 'doc.pdf', { type: 'application/pdf' });
    render(<MessageInput {...defaultProps} />);
    const wrapper = document.querySelector('.message-input-wrapper')!;
    fireEvent.drop(wrapper, { dataTransfer: { files: [file] } });
    expect(screen.getByTestId('page')).toBeInTheDocument();
  });

  it('handles paste with image files', () => {
    render(<MessageInput {...defaultProps} />);
    const textarea = getTextarea();
    const file = new File(['img'], 'pasted.png', { type: 'image/png' });
    const clipboardData = {
      items: [{ type: 'image/png', getAsFile: () => file }],
    };
    fireEvent.paste(textarea, { clipboardData });
    expect(screen.getByText('pasted.png')).toBeInTheDocument();
  });

  it('ignores paste without image files', () => {
    render(<MessageInput {...defaultProps} />);
    const textarea = getTextarea();
    const clipboardData = {
      items: [{ type: 'text/plain', getAsFile: () => null }],
    };
    fireEvent.paste(textarea, { clipboardData });
    // No file previews should appear
    expect(document.querySelector('.message-input-file-previews')).not.toBeInTheDocument();
  });

  it('shows drag overlay when dragging files', () => {
    render(<MessageInput {...defaultProps} />);
    const wrapper = document.querySelector('.message-input-wrapper')!;
    fireEvent.dragOver(wrapper);
    expect(screen.getByText('Drop files here to upload')).toBeInTheDocument();
  });

  it('does not drop when no files in dataTransfer', () => {
    render(<MessageInput {...defaultProps} />);
    const wrapper = document.querySelector('.message-input-wrapper')!;
    fireEvent.drop(wrapper, { dataTransfer: { files: [] } });
    expect(document.querySelector('.message-input-file-previews')).not.toBeInTheDocument();
  });

  it('send button enabled when files are pending even without text', () => {
    const file = new File(['data'], 'test.txt', { type: 'text/plain' });
    render(<MessageInput {...defaultProps} />);
    const wrapper = document.querySelector('.message-input-wrapper')!;
    fireEvent.drop(wrapper, { dataTransfer: { files: [file] } });
    expect(screen.getByTitle('Send Message')).not.toBeDisabled();
  });

  it('sends files without text when onUploadFile is provided', async () => {
    const mockAttachment = { id: 'att-1', message_id: 'msg-1', filename: 'test.txt', content_type: 'text/plain', size: 4, url: '/test.txt' };
    const onUploadFile = vi.fn().mockResolvedValue(mockAttachment);
    const onSend = vi.fn();
    render(<MessageInput {...defaultProps} onSend={onSend} onUploadFile={onUploadFile} />);

    const file = new File(['data'], 'test.txt', { type: 'text/plain' });
    const wrapper = document.querySelector('.message-input-wrapper')!;
    fireEvent.drop(wrapper, { dataTransfer: { files: [file] } });

    fireEvent.click(screen.getByTitle('Send Message'));

    await vi.waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('', [mockAttachment]);
    });
  });

  it('selects emoji from picker and appends to textarea', async () => {
    const user = userEvent.setup();
    render(<MessageInput {...defaultProps} />);
    const textarea = getTextarea();
    await user.type(textarea, 'hello');

    // Open emoji picker
    fireEvent.click(screen.getByTitle('Emoji'));
    expect(screen.getByTestId('emoji-picker')).toBeInTheDocument();

    // Select an emoji
    fireEvent.click(screen.getByTestId('emoji-select-btn'));

    // Emoji should be appended and picker should close
    expect(textarea).toHaveValue('hello\u{1F600}');
    expect(screen.queryByTestId('emoji-picker')).not.toBeInTheDocument();
  });

  it('opens file input when attach file button is clicked', () => {
    render(<MessageInput {...defaultProps} />);
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const clickSpy = vi.spyOn(fileInput, 'click');
    fireEvent.click(screen.getByTitle('Attach File'));
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  it('shows emoji picker with onClose and onSelect callbacks', () => {
    render(<MessageInput {...defaultProps} />);
    fireEvent.click(screen.getByTitle('Emoji'));
    expect(screen.getByTestId('emoji-picker')).toBeInTheDocument();

    // Close via the onClose callback
    fireEvent.click(screen.getByTestId('emoji-close-btn'));
    expect(screen.queryByTestId('emoji-picker')).not.toBeInTheDocument();
  });

  it('shows typing indicator for one user', async () => {
    const { useMessageStore } = await import('../../stores/messageStore');
    useMessageStore.setState({
      typing: new Map([['ch-1', [{ userId: 'u2', username: 'bob', timestamp: Date.now() }]]]),
    });

    render(<MessageInput {...defaultProps} />);
    // The i18n mock returns the default value string with {{name}} interpolation or the key
    expect(document.querySelector('.typing-indicator')).toBeInTheDocument();
  });

  it('shows typing indicator for two users', async () => {
    const { useMessageStore } = await import('../../stores/messageStore');
    useMessageStore.setState({
      typing: new Map([['ch-1', [
        { userId: 'u2', username: 'bob', timestamp: Date.now() },
        { userId: 'u3', username: 'charlie', timestamp: Date.now() },
      ]]]),
    });

    render(<MessageInput {...defaultProps} />);
    expect(document.querySelector('.typing-indicator')).toBeInTheDocument();
  });

  it('shows typing indicator for several users', async () => {
    const { useMessageStore } = await import('../../stores/messageStore');
    useMessageStore.setState({
      typing: new Map([['ch-1', [
        { userId: 'u2', username: 'bob', timestamp: Date.now() },
        { userId: 'u3', username: 'charlie', timestamp: Date.now() },
        { userId: 'u4', username: 'dave', timestamp: Date.now() },
      ]]]),
    });

    render(<MessageInput {...defaultProps} />);
    expect(document.querySelector('.typing-indicator')).toBeInTheDocument();
  });

  it('clears expired typing users', async () => {
    vi.useFakeTimers();
    const { useMessageStore } = await import('../../stores/messageStore');
    const clearTyping = vi.fn();
    // Set a typing user with old timestamp (expired)
    useMessageStore.setState({
      typing: new Map([['ch-1', [{ userId: 'u2', username: 'bob', timestamp: Date.now() - 10000 }]]]),
      clearTyping,
    });

    render(<MessageInput {...defaultProps} />);

    // Advance past the 1s interval that checks for expired typing
    vi.advanceTimersByTime(1100);

    expect(clearTyping).toHaveBeenCalledWith('ch-1', 'u2');
    vi.useRealTimers();
  });
});
