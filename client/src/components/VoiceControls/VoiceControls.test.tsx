import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import VoiceControls from './VoiceControls';
import { useVoiceStore } from '../../stores/voiceStore';
import { useTeamStore } from '../../stores/teamStore';

vi.mock('iconoir-react', () => ({
  PhoneXmark: () => <span data-testid="icon-phone-xmark" />,
  AppWindow: () => <span data-testid="icon-screen" />,
  VideoCamera: () => <span data-testid="icon-camera" />,
  VideoCameraOff: () => <span data-testid="icon-camera-off" />,
}));

vi.mock('../ConnectionStatus/ConnectionStatus', () => ({
  default: () => <span data-testid="connection-status" />,
}));

// Mock webrtc dynamic import
vi.mock('../../services/webrtc', () => ({
  webrtcService: {
    startScreenShare: vi.fn(() => Promise.resolve()),
    stopScreenShare: vi.fn(() => Promise.resolve()),
    startWebcam: vi.fn(() => Promise.resolve()),
    stopWebcam: vi.fn(() => Promise.resolve()),
  },
}));

function setVoiceState(overrides: Record<string, unknown>) {
  useVoiceStore.setState({
    currentChannelId: 'ch-1',
    currentTeamId: 'team-1',
    connected: true,
    connecting: false,
    screenSharing: false,
    webcamSharing: false,
    leaveChannel: vi.fn(),
    ...overrides,
  } as never);
}

describe('VoiceControls', () => {
  beforeEach(() => {
    useTeamStore.setState({
      channels: new Map([
        ['team-1', [{ id: 'ch-1', teamId: 'team-1', name: 'Voice Lounge', topic: '', type: 'voice' as const, position: 0, category: '' }]],
      ]),
      teams: new Map([['team-1', { id: 'team-1', name: 'My Team' }]]),
    } as never);
    setVoiceState({});
  });

  it('returns null when not connected and not connecting', () => {
    setVoiceState({ connected: false, connecting: false });
    const { container } = render(<VoiceControls />);
    expect(container.firstChild).toBeNull();
  });

  it('renders when connected', () => {
    const { container } = render(<VoiceControls />);
    expect(container.querySelector('.voice-controls')).toBeInTheDocument();
  });

  it('shows Voice Connected text when connected', () => {
    render(<VoiceControls />);
    expect(screen.getByText('Voice Connected')).toBeInTheDocument();
  });

  it('shows Connecting text when connecting', () => {
    setVoiceState({ connected: false, connecting: true });
    render(<VoiceControls />);
    expect(screen.getByText('Connecting')).toBeInTheDocument();
  });

  it('shows channel name and team name', () => {
    render(<VoiceControls />);
    expect(screen.getByText('Voice Lounge / My Team')).toBeInTheDocument();
  });

  it('renders ConnectionStatus component', () => {
    render(<VoiceControls />);
    expect(screen.getByTestId('connection-status')).toBeInTheDocument();
  });

  it('renders screen share button', () => {
    render(<VoiceControls />);
    expect(screen.getByTitle('Share screen')).toBeInTheDocument();
  });

  it('renders stop sharing button when screen sharing', () => {
    setVoiceState({ screenSharing: true });
    render(<VoiceControls />);
    expect(screen.getByTitle('Stop sharing')).toBeInTheDocument();
  });

  it('renders webcam button', () => {
    render(<VoiceControls />);
    expect(screen.getByTitle('Share camera')).toBeInTheDocument();
  });

  it('renders stop camera button when webcam sharing', () => {
    setVoiceState({ webcamSharing: true });
    render(<VoiceControls />);
    expect(screen.getByTitle('Stop camera')).toBeInTheDocument();
  });

  it('renders disconnect button', () => {
    render(<VoiceControls />);
    expect(screen.getByTitle('voice.leave')).toBeInTheDocument();
  });

  it('calls leaveChannel when disconnect button clicked', () => {
    const leaveChannel = vi.fn();
    setVoiceState({ leaveChannel });
    render(<VoiceControls />);
    fireEvent.click(screen.getByTitle('voice.leave'));
    expect(leaveChannel).toHaveBeenCalled();
  });

  it('shows active class on screen share button when sharing', () => {
    setVoiceState({ screenSharing: true });
    render(<VoiceControls />);
    const btn = screen.getByTitle('Stop sharing');
    expect(btn.className).toContain('active');
  });

  it('shows active class on webcam button when sharing', () => {
    setVoiceState({ webcamSharing: true });
    render(<VoiceControls />);
    const btn = screen.getByTitle('Stop camera');
    expect(btn.className).toContain('active');
  });

  it('calls startScreenShare when screen share button clicked', async () => {
    const { webrtcService } = await import('../../services/webrtc');
    render(<VoiceControls />);
    fireEvent.click(screen.getByTitle('Share screen'));
    await vi.waitFor(() => {
      expect(webrtcService.startScreenShare).toHaveBeenCalled();
    });
  });

  it('calls stopScreenShare when stop sharing button clicked', async () => {
    const { webrtcService } = await import('../../services/webrtc');
    setVoiceState({ screenSharing: true });
    render(<VoiceControls />);
    fireEvent.click(screen.getByTitle('Stop sharing'));
    await vi.waitFor(() => {
      expect(webrtcService.stopScreenShare).toHaveBeenCalled();
    });
  });

  it('calls startWebcam when camera button clicked', async () => {
    const { webrtcService } = await import('../../services/webrtc');
    render(<VoiceControls />);
    fireEvent.click(screen.getByTitle('Share camera'));
    await vi.waitFor(() => {
      expect(webrtcService.startWebcam).toHaveBeenCalled();
    });
  });

  it('calls stopWebcam when stop camera button clicked', async () => {
    const { webrtcService } = await import('../../services/webrtc');
    setVoiceState({ webcamSharing: true });
    render(<VoiceControls />);
    fireEvent.click(screen.getByTitle('Stop camera'));
    await vi.waitFor(() => {
      expect(webrtcService.stopWebcam).toHaveBeenCalled();
    });
  });

  it('shows channel name without team when no team name', () => {
    useTeamStore.setState({
      channels: new Map([
        ['team-1', [{ id: 'ch-1', teamId: 'team-1', name: 'Voice Lounge', topic: '', type: 'voice' as const, position: 0, category: '' }]],
      ]),
      teams: new Map(),
    } as never);
    render(<VoiceControls />);
    expect(screen.getByText('Voice Lounge')).toBeInTheDocument();
  });

  it('renders when connecting', () => {
    setVoiceState({ connected: false, connecting: true });
    const { container } = render(<VoiceControls />);
    expect(container.querySelector('.voice-controls')).toBeInTheDocument();
  });

  it('handles screen share failure gracefully', async () => {
    const { webrtcService } = await import('../../services/webrtc');
    vi.mocked(webrtcService.startScreenShare).mockRejectedValueOnce(new Error('Permission denied'));
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<VoiceControls />);
    fireEvent.click(screen.getByTitle('Share screen'));
    await vi.waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[Voice] Screen share failed:'), expect.any(Error));
    });
    consoleSpy.mockRestore();
  });

  it('handles webcam failure gracefully', async () => {
    const { webrtcService } = await import('../../services/webrtc');
    vi.mocked(webrtcService.startWebcam).mockRejectedValueOnce(new Error('No camera'));
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<VoiceControls />);
    fireEvent.click(screen.getByTitle('Share camera'));
    await vi.waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[Voice] Webcam failed:'), expect.any(Error));
    });
    consoleSpy.mockRestore();
  });

  it('shows voice channel name fallback when channel not found', () => {
    setVoiceState({ currentChannelId: 'unknown-ch' });
    useTeamStore.setState({
      channels: new Map([['team-1', []]]),
      teams: new Map([['team-1', { id: 'team-1', name: 'My Team' }]]),
    } as never);
    render(<VoiceControls />);
    // Should show fallback text
    expect(screen.getByText(/My Team/)).toBeInTheDocument();
  });
});
