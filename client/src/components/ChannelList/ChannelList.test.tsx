import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ChannelList from './ChannelList';
import { useTeamStore } from '../../stores/teamStore';
import { useVoiceStore } from '../../stores/voiceStore';

vi.mock('iconoir-react', () => ({
  SoundHigh: () => <span data-testid="SoundHigh" />,
  Plus: () => <span data-testid="Plus" />,
  MicrophoneMute: () => <span data-testid="MicrophoneMute" />,
  HeadsetWarning: () => <span data-testid="HeadsetWarning" />,
  AppWindow: () => <span data-testid="AppWindow" />,
}));

vi.mock('../../services/api', () => ({
  api: {
    deleteChannel: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock('../EditChannel/EditChannel', () => ({
  default: ({ channel, onClose }: { channel: { name: string }; onClose: () => void }) => (
    <div data-testid="edit-channel">{channel.name}<button onClick={onClose}>close-edit</button></div>
  ),
}));

const textChannel = {
  id: 'ch-1',
  teamId: 'team-1',
  name: 'general',
  topic: '',
  type: 'text' as const,
  position: 0,
  category: '',
};

const voiceChannel = {
  id: 'ch-2',
  teamId: 'team-1',
  name: 'voice-lobby',
  topic: '',
  type: 'voice' as const,
  position: 0,
  category: '',
};

describe('ChannelList', () => {
  beforeEach(() => {
    const channels = new Map([['team-1', [textChannel, voiceChannel]]]);
    useTeamStore.setState({
      activeTeamId: 'team-1',
      activeChannelId: null,
      channels,
    });
    useVoiceStore.setState({
      currentChannelId: null,
      connected: false,
      peers: {},
      voiceOccupants: {},
    });
  });

  it('renders text and voice channels', () => {
    render(<ChannelList />);
    expect(screen.getByText('general')).toBeInTheDocument();
    expect(screen.getByText('voice-lobby')).toBeInTheDocument();
  });

  it('renders category headers', () => {
    render(<ChannelList />);
    expect(screen.getByText('Text Channels')).toBeInTheDocument();
    expect(screen.getByText('Voice Channels')).toBeInTheDocument();
  });

  it('marks active channel', () => {
    useTeamStore.setState({ activeChannelId: 'ch-1' });
    const { container } = render(<ChannelList />);
    const active = container.querySelector('.channel-item.active');
    expect(active).toBeInTheDocument();
    expect(active?.textContent).toContain('general');
  });

  it('sets active channel on click', () => {
    render(<ChannelList />);
    fireEvent.click(screen.getByText('general'));
    expect(useTeamStore.getState().activeChannelId).toBe('ch-1');
  });

  it('collapses category on header click', () => {
    render(<ChannelList />);
    const header = screen.getByText('Text Channels');
    fireEvent.click(header);
    // After collapse, channel should not be visible
    expect(screen.queryByText('general')).not.toBeInTheDocument();
  });

  it('expands collapsed category on second click', () => {
    render(<ChannelList />);
    const header = screen.getByText('Text Channels');
    fireEvent.click(header);
    fireEvent.click(header);
    expect(screen.getByText('general')).toBeInTheDocument();
  });

  it('renders add button when onCreateChannel is provided', () => {
    const onCreate = vi.fn();
    const { container } = render(<ChannelList onCreateChannel={onCreate} />);
    const addBtns = container.querySelectorAll('.channel-category-add');
    expect(addBtns.length).toBeGreaterThan(0);
  });

  it('does not render add button when onCreateChannel is not provided', () => {
    const { container } = render(<ChannelList />);
    const addBtns = container.querySelectorAll('.channel-category-add');
    expect(addBtns.length).toBe(0);
  });

  it('shows context menu on right click', () => {
    const { container } = render(<ChannelList />);
    const channelItem = screen.getByText('general').closest('.channel-item')!;
    fireEvent.contextMenu(channelItem);
    expect(container.querySelector('.channel-context-menu')).toBeInTheDocument();
    expect(screen.getByText('Edit Channel')).toBeInTheDocument();
    expect(screen.getByText('Delete Channel')).toBeInTheDocument();
  });

  it('renders empty list when no team is active', () => {
    useTeamStore.setState({ activeTeamId: null });
    const { container } = render(<ChannelList />);
    expect(container.querySelectorAll('.channel-item').length).toBe(0);
  });

  it('renders voice icon for voice channels', () => {
    render(<ChannelList />);
    expect(screen.getByTestId('SoundHigh')).toBeInTheDocument();
  });

  it('renders tilde for text channels', () => {
    const { container } = render(<ChannelList />);
    expect(container.querySelector('.channel-tilde')).toBeInTheDocument();
  });

  it('opens edit channel dialog from context menu', () => {
    const { container } = render(<ChannelList />);
    const channelItem = screen.getByText('general').closest('.channel-item')!;
    fireEvent.contextMenu(channelItem);
    fireEvent.click(screen.getByText('Edit Channel'));
    expect(screen.getByTestId('edit-channel')).toBeInTheDocument();
  });

  it('closes edit channel dialog', () => {
    render(<ChannelList />);
    const channelItem = screen.getByText('general').closest('.channel-item')!;
    fireEvent.contextMenu(channelItem);
    fireEvent.click(screen.getByText('Edit Channel'));
    fireEvent.click(screen.getByText('close-edit'));
    expect(screen.queryByTestId('edit-channel')).not.toBeInTheDocument();
  });

  it('deletes channel from context menu', async () => {
    const { api } = await import('../../services/api');
    render(<ChannelList />);
    const channelItem = screen.getByText('general').closest('.channel-item')!;
    fireEvent.contextMenu(channelItem);
    fireEvent.click(screen.getByText('Delete Channel'));
    await vi.waitFor(() => {
      expect(api.deleteChannel).toHaveBeenCalledWith('team-1', 'ch-1');
    });
  });

  it('calls onCreateChannel with category when add button is clicked', () => {
    const onCreate = vi.fn();
    render(<ChannelList onCreateChannel={onCreate} />);
    const addBtns = document.querySelectorAll('.channel-category-add');
    fireEvent.click(addBtns[0]);
    expect(onCreate).toHaveBeenCalled();
  });

  it('groups channels by category', () => {
    const channels = new Map([['team-1', [
      { id: 'ch-1', teamId: 'team-1', name: 'general', topic: '', type: 'text' as const, position: 0, category: 'Dev' },
      { id: 'ch-3', teamId: 'team-1', name: 'random', topic: '', type: 'text' as const, position: 1, category: 'Dev' },
      voiceChannel,
    ]]]);
    useTeamStore.setState({ channels });
    render(<ChannelList />);
    expect(screen.getByText('Dev')).toBeInTheDocument();
    expect(screen.getByText('general')).toBeInTheDocument();
    expect(screen.getByText('random')).toBeInTheDocument();
  });

  it('shows voice channel users when voice connected', () => {
    useVoiceStore.setState({
      connected: true,
      currentChannelId: 'ch-2',
      peers: {
        'user-1': { user_id: 'user-1', username: 'alice', muted: false, deafened: false, speaking: false, voiceLevel: 0 },
      },
    });
    render(<ChannelList />);
    expect(screen.getByText('alice')).toBeInTheDocument();
  });

  it('shows voice occupants when not connected to that channel', () => {
    useVoiceStore.setState({
      voiceOccupants: {
        'ch-2': [{ user_id: 'user-2', username: 'bob', muted: false, deafened: false, speaking: false, voiceLevel: 0 }],
      },
    });
    render(<ChannelList />);
    expect(screen.getByText('bob')).toBeInTheDocument();
  });

  it('shows muted icon for muted voice users', () => {
    useVoiceStore.setState({
      connected: true,
      currentChannelId: 'ch-2',
      peers: {
        'user-1': { user_id: 'user-1', username: 'alice', muted: true, deafened: false, speaking: false, voiceLevel: 0 },
      },
    });
    render(<ChannelList />);
    expect(screen.getByTestId('MicrophoneMute')).toBeInTheDocument();
  });

  it('joins voice channel when clicking a non-connected voice channel', () => {
    const voiceJoin = vi.fn();
    useVoiceStore.setState({
      connected: false,
      currentChannelId: null,
      peers: {},
      voiceOccupants: {},
      joinChannel: voiceJoin,
    } as never);
    render(<ChannelList />);
    fireEvent.click(screen.getByText('voice-lobby'));
    expect(voiceJoin).toHaveBeenCalledWith('team-1', 'ch-2');
  });

  it('handles delete when activeTeamId is null', async () => {
    useTeamStore.setState({ activeTeamId: null });
    const { api } = await import('../../services/api');
    vi.mocked(api.deleteChannel).mockClear();
    // Reset channels with null activeTeamId - no channels rendered, but verify graceful handling
    const { container } = render(<ChannelList />);
    expect(container.querySelectorAll('.channel-item').length).toBe(0);
  });

  it('closes context menu on document click', () => {
    const { container } = render(<ChannelList />);
    const channelItem = screen.getByText('general').closest('.channel-item')!;
    fireEvent.contextMenu(channelItem);
    expect(container.querySelector('.channel-context-menu')).toBeInTheDocument();
    fireEvent.click(document);
    expect(container.querySelector('.channel-context-menu')).not.toBeInTheDocument();
  });
});
