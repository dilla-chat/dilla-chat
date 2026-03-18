import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const mockNavigate = vi.fn();

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('iconoir-react', () => ({
  Xmark: () => <span data-testid="Xmark" />,
}));

vi.mock('../services/api', () => ({
  api: {
    updateMe: vi.fn().mockResolvedValue({ username: 'testuser', display_name: 'New Name' }),
  },
}));

vi.mock('../services/noiseSuppression', () => ({
  NoiseSuppression: vi.fn().mockImplementation(() => ({
    initWorklet: vi.fn(),
    getWorkletNode: vi.fn(),
    cleanup: vi.fn(),
  })),
}));

vi.mock('../services/notifications', () => ({
  notificationService: {
    setEnabled: vi.fn(),
  },
}));

vi.mock('../components/PasskeyManager/PasskeyManager', () => ({
  default: () => <div data-testid="passkey-manager">PasskeyManager</div>,
}));

vi.mock('../components/SettingsLayout/SettingsLayout', () => ({
  default: ({ children, sections, activeId, onSelect, onClose }: {
    children: React.ReactNode;
    sections: Array<{ label?: string; items: Array<{ id: string; label: string; danger?: boolean }> }>;
    activeId: string;
    onSelect: (id: string) => void;
    onClose: () => void;
  }) => (
    <div data-testid="settings-layout">
      <nav data-testid="settings-nav">
        {sections.flatMap((s) =>
          s.items.map((item) => (
            <button
              key={item.id}
              data-testid={`nav-${item.id}`}
              onClick={() => onSelect(item.id)}
            >
              {item.label}
            </button>
          )),
        )}
      </nav>
      <button data-testid="close-btn" onClick={onClose}>Close</button>
      <div data-testid="settings-content">{children}</div>
    </div>
  ),
}));

vi.mock('../components/TitleBar/TitleBar', () => ({
  default: () => <div data-testid="title-bar">TitleBar</div>,
}));

import UserSettings from './UserSettings';
import { useAuthStore } from '../stores/authStore';
import { useUserSettingsStore } from '../stores/userSettingsStore';
import { useAudioSettingsStore } from '../stores/audioSettingsStore';
import { useTelemetryStore } from '../stores/telemetryStore';

describe('UserSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigate.mockClear();
    useAuthStore.setState({
      isAuthenticated: true,
      publicKey: 'test-public-key-fingerprint',
      derivedKey: 'test-key',
      teams: new Map([
        [
          'team1',
          {
            baseUrl: 'http://localhost:8080',
            token: 'tok',
            user: { id: 'u1', username: 'testuser', display_name: 'Test User' },
            teamInfo: {},
          },
        ],
      ]),
      logout: vi.fn(),
    });
    useUserSettingsStore.setState({
      selectedInputDevice: 'default',
      selectedOutputDevice: 'default',
      inputThreshold: 0.15,
      inputVolume: 1.0,
      outputVolume: 1.0,
      desktopNotifications: true,
      soundNotifications: true,
      theme: 'dark',
    });
    useAudioSettingsStore.setState({
      echoCancellation: true,
      autoGainControl: true,
      inputProfile: 'voice-isolation',
      noiseSuppressionMode: 'none',
      pushToTalk: false,
      pushToTalkKey: 'Space',
    });
    useTelemetryStore.setState({
      enabled: false,
    });
  });

  it('renders inside SettingsLayout', () => {
    render(<UserSettings />);
    expect(screen.getByTestId('settings-layout')).toBeInTheDocument();
  });

  it('shows My Account tab by default with username', () => {
    render(<UserSettings />);
    expect(screen.getByText('@testuser')).toBeInTheDocument();
  });

  it('shows display name', () => {
    render(<UserSettings />);
    expect(screen.getByText('Test User')).toBeInTheDocument();
  });

  it('shows public key fingerprint', () => {
    render(<UserSettings />);
    expect(screen.getByText('test-public-key-fingerprint')).toBeInTheDocument();
  });

  it('shows edit button for display name', () => {
    render(<UserSettings />);
    expect(screen.getByText('Edit')).toBeInTheDocument();
  });

  it('shows user initials in avatar', () => {
    render(<UserSettings />);
    expect(screen.getByText('TU')).toBeInTheDocument();
  });

  it('navigates to /app on close', () => {
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('close-btn'));
    expect(mockNavigate).toHaveBeenCalledWith('/app');
  });

  it('handles logout navigation', () => {
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-logout'));
    expect(mockNavigate).toHaveBeenCalledWith('/welcome');
  });

  // Voice & Video tab
  it('shows device selectors in voice tab', () => {
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));

    expect(screen.getByText('Input Device')).toBeInTheDocument();
    expect(screen.getByText('Output Device')).toBeInTheDocument();
  });

  it('shows volume sliders in voice tab', () => {
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));

    expect(screen.getByText('Input Volume')).toBeInTheDocument();
    expect(screen.getByText('Output Volume')).toBeInTheDocument();
  });

  it('shows input profile radio options', () => {
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));

    expect(screen.getByText('Voice Isolation')).toBeInTheDocument();
    expect(screen.getByText('Studio')).toBeInTheDocument();
    expect(screen.getByText('Custom')).toBeInTheDocument();
  });

  it('shows custom settings when Custom profile selected', () => {
    useAudioSettingsStore.setState({ inputProfile: 'custom' });

    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));

    expect(screen.getByText('Echo Cancellation')).toBeInTheDocument();
    expect(screen.getByText('Push to Talk')).toBeInTheDocument();
  });

  it('does not show custom settings when Voice Isolation profile selected', () => {
    useAudioSettingsStore.setState({ inputProfile: 'voice-isolation' });

    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));

    expect(screen.queryByText('Echo Cancellation')).not.toBeInTheDocument();
    expect(screen.queryByText('Push to Talk')).not.toBeInTheDocument();
  });

  it('shows mic test button', () => {
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));

    expect(screen.getByText('Test Mic')).toBeInTheDocument();
  });

  // Notifications tab
  it('shows notification toggles', () => {
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-notifications'));

    expect(screen.getByText('Desktop Notifications')).toBeInTheDocument();
    expect(screen.getByText('Notification Sounds')).toBeInTheDocument();
  });

  // Appearance tab
  it('shows theme buttons in appearance tab', () => {
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-appearance'));

    expect(screen.getByText('Dark')).toBeInTheDocument();
    expect(screen.getByText('Light')).toBeInTheDocument();
  });

  it('shows dark theme button as active by default', () => {
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-appearance'));

    const darkBtn = screen.getByText('Dark');
    expect(darkBtn.className).toContain('active');
  });

  // Keybinds tab
  it('shows keybind shortcuts', () => {
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-keybinds'));

    expect(screen.getByText('Escape')).toBeInTheDocument();
  });

  // Language tab - requires i18n.options.supportedLngs in mock
  it('renders language nav item', () => {
    render(<UserSettings />);
    expect(screen.getByTestId('nav-language')).toBeInTheDocument();
    expect(screen.getByTestId('nav-language').textContent).toBe('Language');
  });

  // Privacy tab
  it('shows telemetry toggle in privacy tab', () => {
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-privacy'));

    expect(screen.getByText('Anonymous Telemetry')).toBeInTheDocument();
  });

  // Security tab
  it('shows passkey manager in security tab', () => {
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-security'));

    expect(screen.getByTestId('passkey-manager')).toBeInTheDocument();
  });

  // Navigation items
  it('renders all navigation items', () => {
    render(<UserSettings />);

    expect(screen.getByTestId('nav-my-account')).toBeInTheDocument();
    expect(screen.getByTestId('nav-voice-video')).toBeInTheDocument();
    expect(screen.getByTestId('nav-notifications')).toBeInTheDocument();
    expect(screen.getByTestId('nav-appearance')).toBeInTheDocument();
    expect(screen.getByTestId('nav-keybinds')).toBeInTheDocument();
    expect(screen.getByTestId('nav-language')).toBeInTheDocument();
    expect(screen.getByTestId('nav-privacy')).toBeInTheDocument();
    expect(screen.getByTestId('nav-security')).toBeInTheDocument();
    expect(screen.getByTestId('nav-logout')).toBeInTheDocument();
  });

  it('shows push to talk key when PTT is enabled in custom mode', () => {
    useAudioSettingsStore.setState({
      inputProfile: 'custom',
      pushToTalk: true,
      pushToTalkKey: 'Space',
    });

    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));

    expect(screen.getByText('Push to Talk Key')).toBeInTheDocument();
    expect(screen.getByText('Space')).toBeInTheDocument();
  });

  it('shows noise suppression dropdown in custom mode', () => {
    useAudioSettingsStore.setState({ inputProfile: 'custom' });

    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));

    expect(screen.getByText('Noise Suppression')).toBeInTheDocument();
  });

  it('shows public key label when public key exists', () => {
    render(<UserSettings />);
    expect(screen.getByText('Your public key fingerprint')).toBeInTheDocument();
  });
});
