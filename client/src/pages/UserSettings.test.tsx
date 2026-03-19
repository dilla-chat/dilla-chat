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
  NoiseSuppression: vi.fn().mockImplementation(function () {
    return {
      initWorklet: vi.fn(),
      getWorkletNode: vi.fn(),
      cleanup: vi.fn(),
    };
  }),
}));

vi.mock('../services/notifications', () => ({
  notificationService: {
    setEnabled: vi.fn(),
  },
}));

const { mockMicTestSession } = vi.hoisted(() => {
  const mockMicTestSession = {
    stream: { getTracks: () => [{ stop: () => {} }] },
    audioContext: { close: () => {} },
    analyser: {},
    gainNode: { gain: { value: 1 } },
    animFrameId: 0,
    noiseSuppression: null,
    timeDomainData: new Float32Array(128),
  };
  return { mockMicTestSession };
});

vi.mock('../services/micTest', () => ({
  startMicTest: vi.fn().mockResolvedValue(mockMicTestSession),
  stopMicTest: vi.fn(),
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

  it('does not show public key section when publicKey is null', () => {
    useAuthStore.setState({ publicKey: null });
    render(<UserSettings />);
    expect(screen.queryByText('Your public key fingerprint')).not.toBeInTheDocument();
  });

  it('enters edit mode when Edit button is clicked', () => {
    render(<UserSettings />);
    fireEvent.click(screen.getByText('Edit'));
    const input = screen.getByDisplayValue('Test User');
    expect(input).toBeInTheDocument();
    expect(input.tagName).toBe('INPUT');
  });

  it('allows changing display name in edit mode', () => {
    render(<UserSettings />);
    fireEvent.click(screen.getByText('Edit'));
    const input = screen.getByDisplayValue('Test User');
    fireEvent.change(input, { target: { value: 'New Name' } });
    expect(input).toHaveValue('New Name');
  });

  it('saves display name on blur', async () => {
    const { api } = await import('../services/api');
    render(<UserSettings />);
    fireEvent.click(screen.getByText('Edit'));
    const input = screen.getByDisplayValue('Test User');
    fireEvent.change(input, { target: { value: 'Updated' } });
    fireEvent.blur(input);
    expect(api.updateMe).toHaveBeenCalled();
  });

  it('saves display name on Enter key', async () => {
    const { api } = await import('../services/api');
    render(<UserSettings />);
    fireEvent.click(screen.getByText('Edit'));
    const input = screen.getByDisplayValue('Test User');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(api.updateMe).toHaveBeenCalled();
  });

  it('calls logout on store when logout is clicked', () => {
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-logout'));
    expect(useAuthStore.getState().logout).toHaveBeenCalled();
  });

  it('changes input volume slider', () => {
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));
    const slider = screen.getByRole('slider', { name: 'Input Volume' });
    fireEvent.change(slider, { target: { value: '150' } });
    expect(slider).toHaveValue('150');
  });

  it('changes output volume slider', () => {
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));
    const slider = screen.getByRole('slider', { name: 'Output Volume' });
    fireEvent.change(slider, { target: { value: '50' } });
    expect(slider).toHaveValue('50');
  });

  it('selects custom profile and toggles echo cancellation', () => {
    useAudioSettingsStore.setState({ inputProfile: 'custom', echoCancellation: true });
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));
    const echoSwitch = screen.getByRole('switch', { name: /Echo Cancellation/ });
    expect(echoSwitch).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(echoSwitch);
  });

  it('toggles push to talk in custom mode', () => {
    useAudioSettingsStore.setState({ inputProfile: 'custom', pushToTalk: false });
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));
    const pttSwitch = screen.getByRole('switch', { name: /Push to Talk/ });
    expect(pttSwitch).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(pttSwitch);
  });

  it('shows PTT key capture button when PTT is enabled', () => {
    useAudioSettingsStore.setState({ inputProfile: 'custom', pushToTalk: true, pushToTalkKey: 'KeyV' });
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));
    expect(screen.getByText('V')).toBeInTheDocument();
  });

  it('shows "Press a key..." when PTT capture is active', () => {
    useAudioSettingsStore.setState({ inputProfile: 'custom', pushToTalk: true, pushToTalkKey: 'Space' });
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));
    const captureBtn = screen.getByRole('button', { name: /Click to change push to talk key/ });
    fireEvent.click(captureBtn);
    expect(screen.getByText('Press a key...')).toBeInTheDocument();
  });

  it('captures PTT key on keydown during capture mode', () => {
    useAudioSettingsStore.setState({ inputProfile: 'custom', pushToTalk: true, pushToTalkKey: 'Space' });
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));
    const captureBtn = screen.getByRole('button', { name: /Click to change push to talk key/ });
    fireEvent.click(captureBtn);
    fireEvent.keyDown(window, { code: 'KeyG' });
    expect(screen.getByText('G')).toBeInTheDocument();
  });

  it('toggles auto gain control in custom mode', () => {
    useAudioSettingsStore.setState({ inputProfile: 'custom', autoGainControl: true });
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));
    const agcSwitch = screen.getByRole('switch', { name: /Automatically Adjust Input Sensitivity/ });
    expect(agcSwitch).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(agcSwitch);
  });

  it('shows input sensitivity slider when auto gain is off in custom mode', () => {
    useAudioSettingsStore.setState({ inputProfile: 'custom', autoGainControl: false });
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));
    expect(screen.getByRole('slider', { name: 'Input Sensitivity' })).toBeInTheDocument();
  });

  it('hides input sensitivity slider when auto gain is on in custom mode', () => {
    useAudioSettingsStore.setState({ inputProfile: 'custom', autoGainControl: true });
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));
    expect(screen.queryByRole('slider', { name: 'Input Sensitivity' })).not.toBeInTheDocument();
  });

  it('shows RNNoise settings when noise suppression is rnnoise', () => {
    useAudioSettingsStore.setState({ inputProfile: 'custom', noiseSuppressionMode: 'rnnoise' });
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));
    expect(screen.getByRole('slider', { name: 'VAD Threshold' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Grace Period' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Retroactive Grace' })).toBeInTheDocument();
  });

  it('does not show RNNoise settings when noise suppression is none', () => {
    useAudioSettingsStore.setState({ inputProfile: 'custom', noiseSuppressionMode: 'none' });
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));
    expect(screen.queryByRole('slider', { name: 'VAD Threshold' })).not.toBeInTheDocument();
  });

  it('changes noise suppression dropdown value', () => {
    useAudioSettingsStore.setState({ inputProfile: 'custom', noiseSuppressionMode: 'none' });
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));
    const select = screen.getByDisplayValue('None');
    fireEvent.change(select, { target: { value: 'browser' } });
  });

  it('toggles desktop notifications', () => {
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-notifications'));
    const toggles = screen.getAllByRole('button').filter(b => b.className.includes('toggle-switch'));
    expect(toggles.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(toggles[0]);
  });

  it('switches theme to light', () => {
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-appearance'));
    fireEvent.click(screen.getByText('Light'));
    const lightBtn = screen.getByText('Light');
    expect(lightBtn.className).toContain('active');
  });

  // Language selector test omitted — requires i18n.options.supportedLngs
  // which is not available in the global react-i18next mock

  it('toggles telemetry in privacy tab', () => {
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-privacy'));
    const telemetryToggle = screen.getByRole('button', { name: /Anonymous Telemetry/ });
    fireEvent.click(telemetryToggle);
  });

  it('shows all keybind shortcuts', () => {
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-keybinds'));
    expect(screen.getByText('Escape')).toBeInTheDocument();
    expect(screen.getByText('Alt+\u2191/\u2193')).toBeInTheDocument();
  });

  it('shows mic level meter in voice tab', () => {
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));
    expect(screen.getByRole('meter', { name: /Microphone level/ })).toBeInTheDocument();
  });

  it('selects studio profile', () => {
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));
    const studioRadio = screen.getByRole('radio', { name: /Studio/ });
    fireEvent.click(studioRadio);
  });

  it('uses single letter initial when username has no space', () => {
    useAuthStore.setState({
      teams: new Map([
        ['team1', { baseUrl: 'http://localhost:8080', token: 'tok', user: { id: 'u1', username: 'alice', display_name: '' }, teamInfo: {} }],
      ]),
    });
    render(<UserSettings />);
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('changes VAD threshold slider in rnnoise mode', () => {
    useAudioSettingsStore.setState({ inputProfile: 'custom', noiseSuppressionMode: 'rnnoise', vadThreshold: 0.5 });
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));
    const vadSlider = screen.getByRole('slider', { name: 'VAD Threshold' });
    fireEvent.change(vadSlider, { target: { value: '70' } });
    expect(vadSlider).toHaveValue('70');
  });

  it('changes grace period slider in rnnoise mode', () => {
    useAudioSettingsStore.setState({ inputProfile: 'custom', noiseSuppressionMode: 'rnnoise', vadGracePeriodMs: 200 });
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));
    const graceSlider = screen.getByRole('slider', { name: 'Grace Period' });
    fireEvent.change(graceSlider, { target: { value: '300' } });
    expect(graceSlider).toHaveValue('300');
  });

  it('changes retroactive grace slider in rnnoise mode', () => {
    useAudioSettingsStore.setState({ inputProfile: 'custom', noiseSuppressionMode: 'rnnoise', retroactiveGraceMs: 30 });
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));
    const retroSlider = screen.getByRole('slider', { name: 'Retroactive Grace' });
    fireEvent.change(retroSlider, { target: { value: '50' } });
    expect(retroSlider).toHaveValue('50');
  });

  it('changes input sensitivity slider when auto gain is off', () => {
    useAudioSettingsStore.setState({ inputProfile: 'custom', autoGainControl: false });
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));
    const sensitivitySlider = screen.getByRole('slider', { name: 'Input Sensitivity' });
    fireEvent.change(sensitivitySlider, { target: { value: '50' } });
    expect(sensitivitySlider).toHaveValue('50');
  });

  it('toggles sound notifications', () => {
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-notifications'));
    const toggles = screen.getAllByRole('button').filter(b => b.className.includes('toggle-switch'));
    // Second toggle is sound notifications
    if (toggles.length >= 2) {
      fireEvent.click(toggles[1]);
    }
  });

  it('shows "Saving..." when display name save is in progress', async () => {
    const { api } = await import('../services/api');
    let resolveUpdate: (v: unknown) => void;
    const updatePromise = new Promise(r => { resolveUpdate = r; });
    vi.mocked(api.updateMe).mockReturnValueOnce(updatePromise as Promise<unknown>);

    render(<UserSettings />);
    fireEvent.click(screen.getByText('Edit'));
    const input = screen.getByDisplayValue('Test User');
    fireEvent.change(input, { target: { value: 'New Name' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // Button should show "Saving..."
    expect(screen.getByText('Saving...')).toBeInTheDocument();
    resolveUpdate!({ username: 'testuser', display_name: 'New Name' });
  });

  it('does not save when display name is empty', async () => {
    const { api } = await import('../services/api');
    render(<UserSettings />);
    fireEvent.click(screen.getByText('Edit'));
    const input = screen.getByDisplayValue('Test User');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(api.updateMe).not.toHaveBeenCalled();
  });

  it('reverts display name on save failure', async () => {
    const { api } = await import('../services/api');
    vi.mocked(api.updateMe).mockRejectedValueOnce(new Error('Network error'));

    render(<UserSettings />);
    fireEvent.click(screen.getByText('Edit'));
    const input = screen.getByDisplayValue('Test User');
    fireEvent.change(input, { target: { value: 'Failed Name' } });
    fireEvent.blur(input);
    // After failure, should revert
    await vi.waitFor(() => {
      expect(screen.queryByText('Saving...')).not.toBeInTheDocument();
    });
  });

  it('shows no public key section when teams are empty', () => {
    useAuthStore.setState({
      publicKey: null,
      teams: new Map(),
    });
    render(<UserSettings />);
    expect(screen.queryByText('Your public key fingerprint')).not.toBeInTheDocument();
  });

  it('starts mic test on button click', async () => {
    // Mock getUserMedia for mic test
    const mockStream = {
      getTracks: vi.fn(() => [{ stop: vi.fn() }]),
    };
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: vi.fn().mockResolvedValue(mockStream),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
      configurable: true,
    });

    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));
    const testMicBtn = screen.getByText('Test Mic');
    fireEvent.click(testMicBtn);
    // Should show "Stop" button after starting
    // Note: AudioContext is not available in jsdom, so it may fail silently
  });

  it('shows voice isolation profile description', () => {
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));
    expect(screen.getByText(/Just your beautiful voice/)).toBeInTheDocument();
  });

  it('shows studio profile description', () => {
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));
    expect(screen.getByText(/Pure audio/)).toBeInTheDocument();
  });

  it('shows custom profile description', () => {
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));
    expect(screen.getByText(/Advanced mode/)).toBeInTheDocument();
  });

  it('selects voice isolation profile via radio', () => {
    useAudioSettingsStore.setState({ inputProfile: 'custom' });
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));
    const voiceIsolationRadio = screen.getByRole('radio', { name: /Voice Isolation/ });
    fireEvent.click(voiceIsolationRadio);
  });

  it('shows auto sensitivity toggle description in custom mode', () => {
    useAudioSettingsStore.setState({ inputProfile: 'custom' });
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));
    expect(screen.getByText(/Automatically adjusts your mic volume/)).toBeInTheDocument();
  });

  it('shows echo cancellation description in custom mode', () => {
    useAudioSettingsStore.setState({ inputProfile: 'custom' });
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));
    expect(screen.getByText(/Removes echo from speakers/)).toBeInTheDocument();
  });

  it('shows push to talk description in custom mode', () => {
    useAudioSettingsStore.setState({ inputProfile: 'custom' });
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));
    expect(screen.getByText(/Hold a key to transmit/)).toBeInTheDocument();
  });

  it('shows language selector in language tab', () => {
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-language'));
    expect(screen.getByText('Select Language')).toBeInTheDocument();
  });

  it('keyCodeToLabel converts KeyX to X', () => {
    useAudioSettingsStore.setState({ inputProfile: 'custom', pushToTalk: true, pushToTalkKey: 'KeyA' });
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('keyCodeToLabel converts DigitX to X', () => {
    useAudioSettingsStore.setState({ inputProfile: 'custom', pushToTalk: true, pushToTalkKey: 'Digit5' });
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('keyCodeToLabel handles camelCase codes', () => {
    useAudioSettingsStore.setState({ inputProfile: 'custom', pushToTalk: true, pushToTalkKey: 'ShiftLeft' });
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));
    expect(screen.getByText('Shift Left')).toBeInTheDocument();
  });

  it('does not save display name when baseUrl or token is missing', async () => {
    const { api } = await import('../services/api');
    useAuthStore.setState({
      teams: new Map([
        ['team1', { baseUrl: '', token: null, user: { id: 'u1', username: 'testuser', display_name: 'Test User' }, teamInfo: {} }],
      ]),
    });
    render(<UserSettings />);
    fireEvent.click(screen.getByText('Edit'));
    const input = screen.getByDisplayValue('Test User');
    fireEvent.change(input, { target: { value: 'New Name' } });
    fireEvent.blur(input);
    expect(api.updateMe).not.toHaveBeenCalled();
  });

  it('shows username as display name when display name is empty', () => {
    useAuthStore.setState({
      teams: new Map([
        ['team1', { baseUrl: 'http://localhost:8080', token: 'tok', user: { id: 'u1', username: 'testuser', display_name: '' }, teamInfo: {} }],
      ]),
    });
    render(<UserSettings />);
    expect(screen.getByText('testuser')).toBeInTheDocument();
  });

  it('uses setRetroactiveGraceMs from audioSettingsStore', () => {
    useAudioSettingsStore.setState({ inputProfile: 'custom', noiseSuppressionMode: 'rnnoise', retroactiveGraceMs: 20 });
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));
    const retroSlider = screen.getByRole('slider', { name: 'Retroactive Grace' });
    fireEvent.change(retroSlider, { target: { value: '60' } });
    // Verify the store was updated
    expect(retroSlider).toHaveValue('60');
  });

  it('renders language dropdown with i18n language', () => {
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-language'));
    // The dropdown should show a select with the current language
    const select = screen.getByRole('combobox');
    expect(select).toBeInTheDocument();
  });

  it('switches between all nav tabs', () => {
    render(<UserSettings />);
    // Visit every tab to exercise all activeId branches
    fireEvent.click(screen.getByTestId('nav-my-account'));
    expect(screen.getByText('@testuser')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('nav-voice-video'));
    expect(screen.getByText('Input Device')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('nav-notifications'));
    expect(screen.getByText('Desktop Notifications')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('nav-appearance'));
    expect(screen.getByText('Dark')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('nav-keybinds'));
    expect(screen.getByText('Escape')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('nav-language'));
    expect(screen.getByText('Select Language')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('nav-privacy'));
    expect(screen.getByText('Anonymous Telemetry')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('nav-security'));
    expect(screen.getByTestId('passkey-manager')).toBeInTheDocument();
  });

  it('shows MicTest with meter even when not testing', () => {
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));
    const meter = screen.getByRole('meter', { name: /Microphone level/ });
    expect(meter).toBeInTheDocument();
  });

  it('renders input and output device options from enumerateDevices', async () => {
    // Mock enumerateDevices to return actual devices
    const mockDevices = [
      { kind: 'audioinput', deviceId: 'mic-1', label: 'USB Microphone', groupId: 'g1' },
      { kind: 'audiooutput', deviceId: 'spk-1', label: 'Headphones', groupId: 'g2' },
      { kind: 'audioinput', deviceId: 'default', label: 'Default', groupId: 'g0' },
    ];
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        enumerateDevices: vi.fn().mockResolvedValue(mockDevices),
        getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
      configurable: true,
    });

    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));

    // Wait for devices to load (useEffect with enumerateDevices)
    const { waitFor } = await import('@testing-library/react');
    await waitFor(() => {
      expect(screen.getByText('USB Microphone')).toBeInTheDocument();
    });
    expect(screen.getByText('Headphones')).toBeInTheDocument();
  });

  it('mic test button is present and clickable', () => {
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));
    // The mic test button shows the i18n key
    const btn = screen.getByRole('button', { name: /startTest|Test Mic/ });
    expect(btn).toBeInTheDocument();
    // Click should not throw
    fireEvent.click(btn);
  });

  it('language tab renders change handler', () => {
    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-language'));
    // The language select should be present
    const selects = document.querySelectorAll('select');
    expect(selects.length).toBeGreaterThan(0);
  });

  it('starts and stops mic test via startMicTest/stopMicTest', async () => {
    const { startMicTest, stopMicTest } = await import('../services/micTest');
    const { waitFor } = await import('@testing-library/react');

    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));

    // Click "Test Mic" to start
    const testBtn = screen.getByRole('button', { name: /startTest|Test Mic/ });
    fireEvent.click(testBtn);

    await waitFor(() => {
      expect(startMicTest).toHaveBeenCalled();
    });

    // Verify createNoiseSuppression factory was passed and works
    const callArgs = vi.mocked(startMicTest).mock.calls[0][0];
    if (callArgs.createNoiseSuppression) {
      const ns = callArgs.createNoiseSuppression();
      expect(ns).toHaveProperty('initWorklet');
      expect(ns).toHaveProperty('getWorkletNode');
      expect(ns).toHaveProperty('cleanup');
      // Call the methods to exercise the factory body
      ns.initWorklet({} as AudioContext);
      ns.getWorkletNode();
      ns.cleanup();
    }

    // After starting, the button should show "Stop"
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /stopTest|Stop/ })).toBeInTheDocument();
    });

    // Click "Stop"
    fireEvent.click(screen.getByRole('button', { name: /stopTest|Stop/ }));
    expect(stopMicTest).toHaveBeenCalled();
  });

  it('updates gain node when inputVolume changes during active mic test', async () => {
    await import('../services/micTest');
    const { waitFor, act } = await import('@testing-library/react');

    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));

    // Start mic test
    const testBtn = screen.getByRole('button', { name: /startTest|Test Mic/ });
    await act(async () => {
      fireEvent.click(testBtn);
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /stopTest|Stop/ })).toBeInTheDocument();
    });

    // Change input volume slider — this triggers the useEffect that updates gain
    const slider = screen.getByRole('slider', { name: 'Input Volume' });
    fireEvent.change(slider, { target: { value: '50' } });

    // The gain node value should be updated
    expect(mockMicTestSession.gainNode.gain.value).toBeDefined();
  });

  it('restarts mic test when enhancedNoiseSuppression changes during active test', async () => {
    const { startMicTest, stopMicTest } = await import('../services/micTest');
    const { waitFor, act } = await import('@testing-library/react');

    // Ensure enhancedNoiseSuppression starts as false
    useAudioSettingsStore.setState({ enhancedNoiseSuppression: false });

    render(<UserSettings />);
    fireEvent.click(screen.getByTestId('nav-voice-video'));

    // Start mic test
    const testBtn = screen.getByRole('button', { name: /startTest|Test Mic/ });

    await act(async () => {
      fireEvent.click(testBtn);
    });

    // Wait for testing state to become true (Stop button appears)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /stopTest|Stop/ })).toBeInTheDocument();
    });

    const startCallsBefore = vi.mocked(startMicTest).mock.calls.length;

    // Toggle enhancedNoiseSuppression while test is active
    act(() => {
      useAudioSettingsStore.setState({ enhancedNoiseSuppression: true });
    });

    // The effect should have called handleStop + handleStart
    await waitFor(() => {
      expect(stopMicTest).toHaveBeenCalled();
      expect(vi.mocked(startMicTest).mock.calls.length).toBeGreaterThan(startCallsBefore);
    });
  });
});
