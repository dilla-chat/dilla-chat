import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import EditChannel from './EditChannel';
import { useTeamStore, type Channel } from '../../stores/teamStore';

vi.mock('../../services/api', () => ({
  api: {
    updateChannel: vi.fn(() => Promise.resolve()),
  },
}));

const channel: Channel = {
  id: 'ch-1',
  teamId: 'team-1',
  name: 'general',
  topic: 'General discussion',
  type: 'text',
  position: 0,
  category: 'Text',
};

describe('EditChannel', () => {
  beforeEach(() => {
    const channels = new Map([['team-1', [channel]]]);
    useTeamStore.setState({
      activeTeamId: 'team-1',
      channels,
    });
  });

  it('renders the modal with Edit Channel heading', () => {
    render(<EditChannel channel={channel} onClose={vi.fn()} />);
    expect(screen.getByText('Edit Channel')).toBeInTheDocument();
  });

  it('populates name input with channel name', () => {
    render(<EditChannel channel={channel} onClose={vi.fn()} />);
    const input = screen.getByDisplayValue('general');
    expect(input).toBeInTheDocument();
  });

  it('populates topic textarea with channel topic', () => {
    render(<EditChannel channel={channel} onClose={vi.fn()} />);
    const textarea = screen.getByDisplayValue('General discussion');
    expect(textarea).toBeInTheDocument();
  });

  it('calls onClose when cancel button is clicked', () => {
    const onClose = vi.fn();
    render(<EditChannel channel={channel} onClose={onClose} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when overlay is clicked', () => {
    const onClose = vi.fn();
    const { container } = render(<EditChannel channel={channel} onClose={onClose} />);
    const overlay = container.querySelector('.edit-channel-overlay')!;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not call onClose when modal content is clicked', () => {
    const onClose = vi.fn();
    const { container } = render(<EditChannel channel={channel} onClose={onClose} />);
    const modal = container.querySelector('.edit-channel-modal')!;
    fireEvent.click(modal);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('disables save button when name is empty', () => {
    render(<EditChannel channel={channel} onClose={vi.fn()} />);
    const nameInput = screen.getByDisplayValue('general');
    fireEvent.change(nameInput, { target: { value: '' } });
    const saveBtn = screen.getByText('Save');
    expect(saveBtn).toBeDisabled();
  });

  it('calls api.updateChannel when saving with changes', async () => {
    const { api } = await import('../../services/api');
    const onClose = vi.fn();
    render(<EditChannel channel={channel} onClose={onClose} />);

    const nameInput = screen.getByDisplayValue('general');
    fireEvent.change(nameInput, { target: { value: 'updated-general' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(api.updateChannel).toHaveBeenCalledWith('team-1', 'ch-1', { name: 'updated-general' });
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('shows new category input when __new__ is selected', () => {
    render(<EditChannel channel={channel} onClose={vi.fn()} />);
    const select = screen.getByDisplayValue('Text');
    fireEvent.change(select, { target: { value: '__new__' } });
    expect(screen.getByPlaceholderText('Category name')).toBeInTheDocument();
  });

  it('shows error when api.updateChannel fails', async () => {
    const { api } = await import('../../services/api');
    vi.mocked(api.updateChannel).mockRejectedValueOnce(new Error('Update failed'));
    render(<EditChannel channel={channel} onClose={vi.fn()} />);

    const nameInput = screen.getByDisplayValue('general');
    fireEvent.change(nameInput, { target: { value: 'new-name' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(screen.getByText('Update failed')).toBeInTheDocument();
    });
  });

  it('shows generic error when api.updateChannel rejects non-Error', async () => {
    const { api } = await import('../../services/api');
    vi.mocked(api.updateChannel).mockRejectedValueOnce('string error');
    render(<EditChannel channel={channel} onClose={vi.fn()} />);

    const nameInput = screen.getByDisplayValue('general');
    fireEvent.change(nameInput, { target: { value: 'new-name' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(screen.getByText('Failed to update channel')).toBeInTheDocument();
    });
  });

  it('saves with new category when __new__ is selected', async () => {
    const { api } = await import('../../services/api');
    const onClose = vi.fn();
    render(<EditChannel channel={channel} onClose={onClose} />);

    const select = screen.getByDisplayValue('Text');
    fireEvent.change(select, { target: { value: '__new__' } });
    const newCatInput = screen.getByPlaceholderText('Category name');
    fireEvent.change(newCatInput, { target: { value: 'New Cat' } });

    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(api.updateChannel).toHaveBeenCalledWith('team-1', 'ch-1', expect.objectContaining({ category: 'New Cat' }));
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('does not call API when nothing changed', async () => {
    const { api } = await import('../../services/api');
    vi.mocked(api.updateChannel).mockClear();
    const onClose = vi.fn();
    render(<EditChannel channel={channel} onClose={onClose} />);
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
      expect(api.updateChannel).not.toHaveBeenCalled();
    });
  });

  it('does not save when activeTeamId is null', async () => {
    useTeamStore.setState({ activeTeamId: null });
    const { api } = await import('../../services/api');
    vi.mocked(api.updateChannel).mockClear();
    render(<EditChannel channel={channel} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('Save'));
    expect(api.updateChannel).not.toHaveBeenCalled();
  });

  it('renders category select with existing categories', () => {
    const channels = new Map([
      ['team-1', [
        channel,
        { ...channel, id: 'ch-2', name: 'dev', category: 'Development' },
      ]],
    ]);
    useTeamStore.setState({ channels });

    render(<EditChannel channel={channel} onClose={vi.fn()} />);
    expect(screen.getByText('Development')).toBeInTheDocument();
  });
});
