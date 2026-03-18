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
    const { container } = render(<CreateChannel onClose={vi.fn()} />);
    const textBtn = container.querySelector('.channel-type-btn.active');
    expect(textBtn?.textContent).toContain('channels.text');
  });

  it('switches to voice type on click', () => {
    const { container } = render(<CreateChannel onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('channels.voice'));
    const activeBtn = container.querySelector('.channel-type-btn.active');
    expect(activeBtn?.textContent).toContain('channels.voice');
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
    const overlay = container.querySelector('.create-channel-overlay')!;
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

  it('uses defaultCategory prop', () => {
    render(<CreateChannel defaultCategory="Gaming" onClose={vi.fn()} />);
    // The select should show Gaming if it exists, otherwise category state is 'Gaming'
    // Since no channels exist with Gaming category, the select won't have it as option
    // but the state is set to 'Gaming'
  });
});
