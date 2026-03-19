import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import UserPanel from './UserPanel';
import { usePresenceStore } from '../../stores/presenceStore';
import { useTeamStore } from '../../stores/teamStore';
import { useAuthStore } from '../../stores/authStore';
import { useVoiceStore } from '../../stores/voiceStore';

vi.mock('iconoir-react', () => ({
  Settings: () => <span data-testid="icon-settings" />,
  Microphone: () => <span data-testid="icon-mic" />,
  MicrophoneMute: () => <span data-testid="icon-mic-mute" />,
  Headset: () => <span data-testid="icon-headset" />,
  HeadsetWarning: () => <span data-testid="icon-headset-warning" />,
}));

vi.mock('../../services/websocket', () => ({
  ws: {
    updatePresence: vi.fn(),
  },
}));

vi.mock('../../services/webrtc', () => ({
  webrtcService: {
    toggleMute: vi.fn(),
    toggleDeafen: vi.fn(),
  },
}));

vi.mock('../../utils/sounds', () => ({
  playMuteSound: vi.fn(),
  playUnmuteSound: vi.fn(),
}));

vi.mock('../PresenceIndicator/PresenceIndicator', () => ({
  default: ({ status }: { status: string }) => (
    <span data-testid="presence-indicator" data-status={status} />
  ),
}));

vi.mock('../StatusPicker/StatusPicker', () => ({
  default: ({ onStatusChange, onCustomStatusChange, onClose }: { onStatusChange: (s: string) => void; onCustomStatusChange: (s: string) => void; onClose: () => void }) => (
    <div data-testid="status-picker">
      <button data-testid="set-away" onClick={() => onStatusChange('away')}>Set Away</button>
      <button data-testid="set-custom" onClick={() => onCustomStatusChange('Busy')}>Set Custom</button>
      <button data-testid="close-picker" onClick={onClose}>Close</button>
    </div>
  ),
}));

describe('UserPanel', () => {
  beforeEach(() => {
    useTeamStore.setState({ activeTeamId: 'team-1' });
    useAuthStore.setState({
      teams: new Map([['team-1', { user: { id: 'user-1' } }]]),
    } as never);
    usePresenceStore.setState({
      myStatus: 'online',
      myCustomStatus: '',
    });
    useVoiceStore.setState({
      muted: false,
      deafened: false,
    } as never);
  });

  it('renders username', () => {
    render(<UserPanel username="alice" />);
    expect(screen.getByText('alice')).toBeInTheDocument();
  });

  it('renders display name when provided', () => {
    render(<UserPanel username="alice" displayName="Alice Johnson" />);
    expect(screen.getByText('Alice Johnson')).toBeInTheDocument();
  });

  it('renders initials from display name', () => {
    render(<UserPanel username="alice" displayName="Alice Johnson" />);
    // Initials: AJ
    const avatar = document.querySelector('.user-panel-avatar');
    expect(avatar?.textContent).toContain('AJ');
  });

  it('renders initials from username when no display name', () => {
    render(<UserPanel username="alice" />);
    const avatar = document.querySelector('.user-panel-avatar');
    // 'alice' is one word, so initials = 'A'
    expect(avatar?.textContent).toContain('A');
  });

  it('renders presence indicator', () => {
    render(<UserPanel username="alice" />);
    expect(screen.getByTestId('presence-indicator')).toBeInTheDocument();
    expect(screen.getByTestId('presence-indicator')).toHaveAttribute('data-status', 'online');
  });

  it('shows presence status text', () => {
    render(<UserPanel username="alice" />);
    expect(screen.getByText('presence.online')).toBeInTheDocument();
  });

  it('shows custom status text when set', () => {
    usePresenceStore.setState({ myCustomStatus: 'Working hard' });
    render(<UserPanel username="alice" />);
    expect(screen.getByText('Working hard')).toBeInTheDocument();
  });

  it('renders mute button', () => {
    render(<UserPanel username="alice" />);
    expect(screen.getByTitle('Mute')).toBeInTheDocument();
  });

  it('renders deafen button', () => {
    render(<UserPanel username="alice" />);
    expect(screen.getByTitle('Deafen')).toBeInTheDocument();
  });

  it('shows muted mic icon when muted', () => {
    useVoiceStore.setState({ muted: true } as never);
    render(<UserPanel username="alice" />);
    expect(screen.getByTestId('icon-mic-mute')).toBeInTheDocument();
  });

  it('shows unmuted mic icon when not muted', () => {
    render(<UserPanel username="alice" />);
    expect(screen.getByTestId('icon-mic')).toBeInTheDocument();
  });

  it('shows headset warning icon when deafened', () => {
    useVoiceStore.setState({ deafened: true } as never);
    render(<UserPanel username="alice" />);
    expect(screen.getByTestId('icon-headset-warning')).toBeInTheDocument();
  });

  it('disables mute button when deafened', () => {
    useVoiceStore.setState({ deafened: true } as never);
    render(<UserPanel username="alice" />);
    const muteBtn = screen.getByTitle('Deafened');
    expect(muteBtn).toBeDisabled();
  });

  it('calls onSettingsClick when settings button clicked', () => {
    const onSettings = vi.fn();
    render(<UserPanel username="alice" onSettingsClick={onSettings} />);
    fireEvent.click(screen.getByTitle('settings.general'));
    expect(onSettings).toHaveBeenCalled();
  });

  it('renders settings button', () => {
    render(<UserPanel username="alice" />);
    expect(screen.getByTitle('settings.general')).toBeInTheDocument();
  });

  it('toggles status picker on avatar click', () => {
    render(<UserPanel username="alice" />);
    expect(screen.queryByTestId('status-picker')).not.toBeInTheDocument();
    const avatar = document.querySelector('.user-panel-avatar')!;
    fireEvent.click(avatar);
    expect(screen.getByTestId('status-picker')).toBeInTheDocument();
  });

  it('toggles status picker on info click', () => {
    render(<UserPanel username="alice" />);
    const info = document.querySelector('.user-panel-info')!;
    fireEvent.click(info);
    expect(screen.getByTestId('status-picker')).toBeInTheDocument();
  });

  it('closes status picker on second avatar click', () => {
    render(<UserPanel username="alice" />);
    const avatar = document.querySelector('.user-panel-avatar')!;
    fireEvent.click(avatar);
    expect(screen.getByTestId('status-picker')).toBeInTheDocument();
    fireEvent.click(avatar);
    expect(screen.queryByTestId('status-picker')).not.toBeInTheDocument();
  });

  it('mute button calls toggleMute and plays sound', async () => {
    const { playMuteSound } = await import('../../utils/sounds');
    const { webrtcService } = await import('../../services/webrtc');
    render(<UserPanel username="alice" />);
    fireEvent.click(screen.getByTitle('Mute'));
    expect(playMuteSound).toHaveBeenCalled();
    expect(webrtcService.toggleMute).toHaveBeenCalled();
  });

  it('unmute button calls toggleMute and plays unmute sound', async () => {
    useVoiceStore.setState({ muted: true } as never);
    const { playUnmuteSound } = await import('../../utils/sounds');
    const { webrtcService } = await import('../../services/webrtc');
    render(<UserPanel username="alice" />);
    // Muted state shows 'Unmute' title
    fireEvent.click(screen.getByTitle('Unmute'));
    expect(playUnmuteSound).toHaveBeenCalled();
    expect(webrtcService.toggleMute).toHaveBeenCalled();
  });

  it('deafen button calls toggleDeafen and plays sound', async () => {
    const { playMuteSound } = await import('../../utils/sounds');
    const { webrtcService } = await import('../../services/webrtc');
    render(<UserPanel username="alice" />);
    fireEvent.click(screen.getByTitle('Deafen'));
    expect(playMuteSound).toHaveBeenCalled();
    expect(webrtcService.toggleDeafen).toHaveBeenCalled();
  });

  it('undeafen button calls toggleDeafen and plays unmute sound', async () => {
    useVoiceStore.setState({ deafened: true } as never);
    const { playUnmuteSound } = await import('../../utils/sounds');
    const { webrtcService } = await import('../../services/webrtc');
    render(<UserPanel username="alice" />);
    fireEvent.click(screen.getByTitle('Undeafen'));
    expect(playUnmuteSound).toHaveBeenCalled();
    expect(webrtcService.toggleDeafen).toHaveBeenCalled();
  });

  it('shows muted icon with active class when muted', () => {
    useVoiceStore.setState({ muted: true } as never);
    const { container } = render(<UserPanel username="alice" />);
    const muteBtn = container.querySelector('.user-panel-btn-active');
    expect(muteBtn).toBeInTheDocument();
  });

  it('renders without activeTeamId', () => {
    useTeamStore.setState({ activeTeamId: null });
    render(<UserPanel username="alice" />);
    expect(screen.getByText('alice')).toBeInTheDocument();
  });

  it('closes status picker on outside click', () => {
    render(<UserPanel username="alice" />);
    const avatar = document.querySelector('.user-panel-avatar')!;
    fireEvent.click(avatar);
    expect(screen.getByTestId('status-picker')).toBeInTheDocument();
    // Simulate clicking outside (on document body)
    fireEvent.click(document.body);
    expect(screen.queryByTestId('status-picker')).not.toBeInTheDocument();
  });

  it('shows different presence status text for offline', () => {
    usePresenceStore.setState({ myStatus: 'offline' });
    render(<UserPanel username="alice" />);
    expect(screen.getByText('presence.offline')).toBeInTheDocument();
  });

  it('shows different presence status text for away', () => {
    usePresenceStore.setState({ myStatus: 'away' });
    render(<UserPanel username="alice" />);
    expect(screen.getByText('presence.away')).toBeInTheDocument();
  });

  it('shows deafen button with correct title', () => {
    render(<UserPanel username="alice" />);
    expect(screen.getByTitle('Deafen')).toBeInTheDocument();
  });

  it('shows Undeafen title when deafened', () => {
    useVoiceStore.setState({ deafened: true } as never);
    render(<UserPanel username="alice" />);
    expect(screen.getByTitle('Undeafen')).toBeInTheDocument();
  });

  it('renders with all action buttons', () => {
    render(<UserPanel username="alice" />);
    // Mute, Deafen, Settings
    const buttons = document.querySelectorAll('.user-panel-btn');
    expect(buttons.length).toBe(3);
  });

  it('handleStatusChange updates presence via WS', async () => {
    const { ws } = await import('../../services/websocket');
    vi.mocked(ws.updatePresence).mockClear();
    render(<UserPanel username="alice" />);
    const avatar = document.querySelector('.user-panel-avatar')!;
    fireEvent.click(avatar);
    fireEvent.click(screen.getByTestId('set-away'));
    expect(ws.updatePresence).toHaveBeenCalledWith('team-1', 'away', undefined);
  });

  it('handleCustomStatusChange updates presence via WS', async () => {
    const { ws } = await import('../../services/websocket');
    vi.mocked(ws.updatePresence).mockClear();
    render(<UserPanel username="alice" />);
    const info = document.querySelector('.user-panel-info')!;
    fireEvent.click(info);
    fireEvent.click(screen.getByTestId('set-custom'));
    expect(ws.updatePresence).toHaveBeenCalledWith('team-1', 'online', 'Busy');
  });

  it('closes status picker via onClose', () => {
    render(<UserPanel username="alice" />);
    const avatar = document.querySelector('.user-panel-avatar')!;
    fireEvent.click(avatar);
    expect(screen.getByTestId('status-picker')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('close-picker'));
    expect(screen.queryByTestId('status-picker')).not.toBeInTheDocument();
  });

  it('renders without activeTeamId and currentUserId empty', () => {
    useTeamStore.setState({ activeTeamId: null });
    useAuthStore.setState({ teams: new Map() } as never);
    render(<UserPanel username="alice" />);
    expect(screen.getByText('alice')).toBeInTheDocument();
  });
});
