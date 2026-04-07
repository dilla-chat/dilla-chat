import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import QuickSwitcher from './QuickSwitcher';
import { useTeamStore } from '../../stores/teamStore';
import { useDMStore } from '../../stores/dmStore';

vi.mock('@tabler/icons-react', () => ({
  IconSearch: () => <span data-testid="search-icon" />,
  IconHash: () => <span data-testid="hash-icon" />,
  IconVolume: () => <span data-testid="volume-icon" />,
  IconMessage: () => <span data-testid="message-icon" />,
}));

const channels = new Map([
  [
    'team-1',
    [
      { id: 'ch-1', teamId: 'team-1', name: 'general', topic: '', type: 'text' as const, position: 0, category: '' },
      { id: 'ch-2', teamId: 'team-1', name: 'voice-room', topic: '', type: 'voice' as const, position: 0, category: '' },
      { id: 'ch-3', teamId: 'team-1', name: 'random', topic: '', type: 'text' as const, position: 0, category: '' },
    ],
  ],
]);

const teams = new Map([
  ['team-1', { id: 'team-1', name: 'Berras', baseUrl: '', description: '', icon: '' }],
]);

describe('QuickSwitcher', () => {
  const onClose = vi.fn();
  const onSelect = vi.fn();

  beforeEach(() => {
    cleanup();
    onClose.mockReset();
    onSelect.mockReset();
    useTeamStore.setState({ channels, teams: teams as never, activeTeamId: 'team-1' });
    useDMStore.setState({ dmChannels: {} });
  });

  it('renders nothing when closed', () => {
    const { container } = render(<QuickSwitcher open={false} onClose={onClose} onSelect={onSelect} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders all channels when open with empty query', () => {
    render(<QuickSwitcher open={true} onClose={onClose} onSelect={onSelect} />);
    expect(screen.getByText('general')).toBeInTheDocument();
    expect(screen.getByText('voice-room')).toBeInTheDocument();
    expect(screen.getByText('random')).toBeInTheDocument();
  });

  it('filters channels by query', () => {
    render(<QuickSwitcher open={true} onClose={onClose} onSelect={onSelect} />);
    const input = screen.getByLabelText('Search channels');
    fireEvent.change(input, { target: { value: 'gen' } });
    expect(screen.getByText('general')).toBeInTheDocument();
    expect(screen.queryByText('random')).not.toBeInTheDocument();
  });

  it('shows empty state when no matches', () => {
    render(<QuickSwitcher open={true} onClose={onClose} onSelect={onSelect} />);
    fireEvent.change(screen.getByLabelText('Search channels'), { target: { value: 'zzz' } });
    expect(screen.getByText('No results')).toBeInTheDocument();
  });

  it('selects item on click and calls onSelect+onClose', () => {
    render(<QuickSwitcher open={true} onClose={onClose} onSelect={onSelect} />);
    fireEvent.click(screen.getByText('general'));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: 'general', type: 'text' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('navigates with ArrowDown / ArrowUp', () => {
    render(<QuickSwitcher open={true} onClose={onClose} onSelect={onSelect} />);
    const switcher = document.querySelector('.quick-switcher')!;
    fireEvent.keyDown(switcher, { key: 'ArrowDown' });
    fireEvent.keyDown(switcher, { key: 'ArrowDown' });
    const items = document.querySelectorAll('.quick-switcher-item');
    expect(items[2]).toHaveClass('selected');
    fireEvent.keyDown(switcher, { key: 'ArrowUp' });
    expect(document.querySelectorAll('.quick-switcher-item')[1]).toHaveClass('selected');
  });

  it('selects current item on Enter', () => {
    render(<QuickSwitcher open={true} onClose={onClose} onSelect={onSelect} />);
    const switcher = document.querySelector('.quick-switcher')!;
    fireEvent.keyDown(switcher, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    render(<QuickSwitcher open={true} onClose={onClose} onSelect={onSelect} />);
    fireEvent.keyDown(document.querySelector('.quick-switcher')!, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on overlay mouseDown', () => {
    render(<QuickSwitcher open={true} onClose={onClose} onSelect={onSelect} />);
    fireEvent.mouseDown(document.querySelector('.quick-switcher-overlay')!);
    expect(onClose).toHaveBeenCalled();
  });

  it('does not close when mouseDown inside switcher panel', () => {
    render(<QuickSwitcher open={true} onClose={onClose} onSelect={onSelect} />);
    fireEvent.mouseDown(document.querySelector('.quick-switcher')!);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('updates selected index on hover', () => {
    render(<QuickSwitcher open={true} onClose={onClose} onSelect={onSelect} />);
    const items = document.querySelectorAll('.quick-switcher-item');
    fireEvent.mouseEnter(items[1]);
    expect(items[1]).toHaveClass('selected');
  });

  it('renders DMs from store', () => {
    useDMStore.setState({
      dmChannels: {
        'team-1': [
          {
            id: 'dm-1',
            is_group: false,
            members: [{ user_id: 'u1', username: 'alice', display_name: 'Alice' }],
          } as never,
        ],
      },
    });
    render(<QuickSwitcher open={true} onClose={onClose} onSelect={onSelect} />);
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });
});
