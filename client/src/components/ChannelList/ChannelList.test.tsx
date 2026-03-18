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
});
