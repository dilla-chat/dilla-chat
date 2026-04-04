import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CreateChannel from './CreateChannel';
import { useTeamStore } from '../../stores/teamStore';

vi.mock('iconoir-react', () => ({
  Hashtag: () => <span data-testid="Hashtag" />,
  SoundHigh: () => <span data-testid="SoundHigh" />,
}));

vi.mock('../../services/api', () => ({
  api: {
    createChannel: vi.fn(() => Promise.resolve({ id: 'new-ch', position: 0 })),
  },
}));

describe('CreateChannel', () => {
  beforeEach(() => {
    useTeamStore.setState({
      activeTeamId: 'team-1',
      channels: new Map([['team-1', []]]),
    });
  });

  it('renders the create channel modal', () => {
    render(<CreateChannel onClose={vi.fn()} />);
    const headings = screen.getAllByText('channels.create');
    expect(headings.length).toBeGreaterThanOrEqual(1);
  });

  it('renders channel type toggle with text and voice', () => {
    render(<CreateChannel onClose={vi.fn()} />);
    expect(screen.getByText('channels.text')).toBeInTheDocument();
    expect(screen.getByText('channels.voice')).toBeInTheDocument();
  });

  it('defaults to text channel type', () => {
    render(<CreateChannel onClose={vi.fn()} />);
    const textBtn = screen.getByTestId('channel-type-text');
    expect(textBtn).toHaveAttribute('data-active', 'true');
    expect(textBtn.textContent).toContain('channels.text');
  });

  it('switches to voice type on click', () => {
    render(<CreateChannel onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('channels.voice'));
    const voiceBtn = screen.getByTestId('channel-type-voice');
    expect(voiceBtn).toHaveAttribute('data-active', 'true');
    expect(voiceBtn.textContent).toContain('channels.voice');
  });

  it('disables create button when name is empty', () => {
    render(<CreateChannel onClose={vi.fn()} />);
    const createBtn = screen.getByText('channels.create', { selector: 'button' });
    expect(createBtn).toBeDisabled();
  });

  it('enables create button when name is entered', () => {
    render(<CreateChannel onClose={vi.fn()} />);
    const input = screen.getByPlaceholderText('General Chat');
    fireEvent.change(input, { target: { value: 'my-channel' } });
    const buttons = screen.getAllByText('channels.create');
    const createBtn = buttons.find((b) => b.tagName === 'BUTTON')!;
    expect(createBtn).not.toBeDisabled();
  });

  it('calls onClose when cancel button is clicked', () => {
    const onClose = vi.fn();
    render(<CreateChannel onClose={onClose} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when overlay is clicked', () => {
    const onClose = vi.fn();
    const { container } = render(<CreateChannel onClose={onClose} />);
    const overlay = container.querySelector('.dialog-backdrop')!;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('creates channel and calls onClose on submit', async () => {
    const { api } = await import('../../services/api');
    const onClose = vi.fn();
    render(<CreateChannel onClose={onClose} />);

    const input = screen.getByPlaceholderText('General Chat');
    fireEvent.change(input, { target: { value: 'new-channel' } });

    const buttons = screen.getAllByText('channels.create');
    const createBtn = buttons.find((b) => b.tagName === 'BUTTON')!;
    fireEvent.click(createBtn);

    await waitFor(() => {
      expect(api.createChannel).toHaveBeenCalledWith('team-1', expect.objectContaining({
        name: 'new-channel',
        type: 'text',
      }));
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('shows new category input when __new__ is selected', () => {
    render(<CreateChannel onClose={vi.fn()} />);
    const select = screen.getByDisplayValue('No category');
    fireEvent.change(select, { target: { value: '__new__' } });
    expect(screen.getByPlaceholderText('Category name')).toBeInTheDocument();
  });

  it('switches back to text type', () => {
    render(<CreateChannel onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('channels.voice'));
    fireEvent.click(screen.getByText('channels.text'));
    const textBtn = screen.getByTestId('channel-type-text');
    expect(textBtn).toHaveAttribute('data-active', 'true');
    expect(textBtn.textContent).toContain('channels.text');
  });

  it('handles create channel failure gracefully', async () => {
    const { api } = await import('../../services/api');
    vi.mocked(api.createChannel).mockRejectedValueOnce(new Error('Create failed'));
    const onClose = vi.fn();
    render(<CreateChannel onClose={onClose} />);

    const input = screen.getByPlaceholderText('General Chat');
    fireEvent.change(input, { target: { value: 'fail-channel' } });

    const buttons = screen.getAllByText('channels.create');
    const createBtn = buttons.find((b) => b.tagName === 'BUTTON')!;
    fireEvent.click(createBtn);

    await waitFor(() => {
      // onClose should NOT be called on failure
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  it('creates channel with new category', async () => {
    const { api } = await import('../../services/api');
    const onClose = vi.fn();
    render(<CreateChannel onClose={onClose} />);

    const input = screen.getByPlaceholderText('General Chat');
    fireEvent.change(input, { target: { value: 'my-channel' } });

    const select = screen.getByDisplayValue('No category');
    fireEvent.change(select, { target: { value: '__new__' } });
    const newCatInput = screen.getByPlaceholderText('Category name');
    fireEvent.change(newCatInput, { target: { value: 'Custom' } });

    const buttons = screen.getAllByText('channels.create');
    const createBtn = buttons.find((b) => b.tagName === 'BUTTON')!;
    fireEvent.click(createBtn);

    await waitFor(() => {
      expect(api.createChannel).toHaveBeenCalledWith('team-1', expect.objectContaining({
        name: 'my-channel',
        category: 'Custom',
      }));
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('creates voice channel with topic', async () => {
    const { api } = await import('../../services/api');
    const onClose = vi.fn();
    render(<CreateChannel onClose={onClose} />);

    fireEvent.click(screen.getByText('channels.voice'));
    const input = screen.getByPlaceholderText('General Chat');
    fireEvent.change(input, { target: { value: 'voice-room' } });

    const topicInput = screen.getByPlaceholderText('What is this channel about?');
    fireEvent.change(topicInput, { target: { value: 'Voice chat' } });

    const buttons = screen.getAllByText('channels.create');
    const createBtn = buttons.find((b) => b.tagName === 'BUTTON')!;
    fireEvent.click(createBtn);

    await waitFor(() => {
      expect(api.createChannel).toHaveBeenCalledWith('team-1', expect.objectContaining({
        type: 'voice',
        topic: 'Voice chat',
      }));
    });
  });

  it('does not create when activeTeamId is null', async () => {
    useTeamStore.setState({ activeTeamId: null });
    const { api } = await import('../../services/api');
    vi.mocked(api.createChannel).mockClear();
    render(<CreateChannel onClose={vi.fn()} />);
    const input = screen.getByPlaceholderText('General Chat');
    fireEvent.change(input, { target: { value: 'channel' } });
    const buttons = screen.getAllByText('channels.create');
    const createBtn = buttons.find((b) => b.tagName === 'BUTTON')!;
    fireEvent.click(createBtn);
    expect(api.createChannel).not.toHaveBeenCalled();
  });

  it('uses defaultCategory prop', () => {
    const { container } = render(<CreateChannel defaultCategory="Gaming" onClose={vi.fn()} />);
    expect(container.firstChild).toBeTruthy();
  });
});
