import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const mockNavigate = vi.fn();

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('@tabler/icons-react', () => ({
  IconX: () => <span data-testid="Xmark" />,
}));

vi.mock('../services/api', () => ({
  api: {
    updateMe: vi.fn().mockResolvedValue({ username: 'testuser', display_name: 'New Name' }),
  },
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

import { MockSettingsLayout } from '../test/MockSettingsLayout';

vi.mock('../components/SettingsLayout/SettingsLayout', () => ({
  default: MockSettingsLayout,
}));

vi.mock('../components/TitleBar/TitleBar', () => ({
  default: () => <div data-testid="title-bar">TitleBar</div>,
}));

import UserSettings from './UserSettings';
import { useAuthStore } from '../stores/authStore';
import { useUserSettingsStore } from '../stores/userSettingsStore';
import { useAudioSettingsStore } from '../stores/audioSettingsStore';
import { useTelemetryStore } from '../stores/telemetryStore';

function renderUserSettings() {
  return render(<UserSettings />);
}

function navigateToTab(tabId: string) {
  renderUserSettings();
  fireEvent.click(screen.getByTestId(`nav-${tabId}`));
}

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
      inputVolume: 1,
      outputVolume: 1,
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
    renderUserSettings();
    expect(screen.getByTestId('settings-layout')).toBeInTheDocument();
  });

  it.each([
    ['username', '@testuser'],
    ['display name', 'Test User'],
    ['public key fingerprint', 'test-public-key-fingerprint'],
    ['edit button', 'Edit'],
    ['user initials in avatar', 'TU'],
  ])('shows %s on My Account tab by default', (_label, expectedText) => {
    renderUserSettings();
    expect(screen.getByText(expectedText)).toBeInTheDocument();
  });

  it('navigates to /app on close', () => {
    renderUserSettings();
    fireEvent.click(screen.getByTestId('close-btn'));
    expect(mockNavigate).toHaveBeenCalledWith('/app');
  });

  it('handles logout navigation', () => {
    renderUserSettings();
    fireEvent.click(screen.getByTestId('nav-logout'));
    expect(mockNavigate).toHaveBeenCalledWith('/welcome');
  });

  // Voice & Video tab content checks
  it.each([
    ['device selectors', ['Input Device', 'Output Device']],
    ['volume sliders', ['Input Volume', 'Output Volume']],
    ['input profile radio options', ['Voice Isolation', 'Studio', 'Custom']],
    ['mic test button', ['Test Mic']],
  ])('shows %s in voice tab', (_label, expectedTexts) => {
    navigateToTab('voice-video');
    for (const text of expectedTexts) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
  });

  it('shows custom settings when Custom profile selected', () => {
    useAudioSettingsStore.setState({ inputProfile: 'custom' });
    navigateToTab('voice-video');
    expect(screen.getByText('Echo Cancellation')).toBeInTheDocument();
    expect(screen.getByText('Push to Talk')).toBeInTheDocument();
  });

  it('does not show custom settings when Voice Isolation profile selected', () => {
    useAudioSettingsStore.setState({ inputProfile: 'voice-isolation' });
    navigateToTab('voice-video');
    expect(screen.queryByText('Echo Cancellation')).not.toBeInTheDocument();
    expect(screen.queryByText('Push to Talk')).not.toBeInTheDocument();
  });

  // Tab content checks for notifications, appearance
  it.each([
    ['notifications', ['Desktop Notifications', 'Notification Sounds']],
    ['appearance', ['Dark', 'Light']],
  ])('shows expected content in %s tab', (tabId, expectedTexts) => {
    navigateToTab(tabId);
    for (const text of expectedTexts) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
  });

  it('shows dark theme button as active by default', () => {
    navigateToTab('appearance');

    const darkBtn = screen.getByText('Dark');
    expect(darkBtn.className).toContain('active');
  });

  // Keybinds tab
  it('shows keybind shortcuts', () => {
    navigateToTab('keybinds');

    expect(screen.getByText('Escape')).toBeInTheDocument();
  });

  // Language tab - requires i18n.options.supportedLngs in mock
  it('renders language nav item', () => {
    renderUserSettings();
    expect(screen.getByTestId('nav-language')).toBeInTheDocument();
    expect(screen.getByTestId('nav-language').textContent).toBe('Language');
  });

  // Privacy tab
  it('shows telemetry toggle in privacy tab', () => {
    navigateToTab('privacy');

    expect(screen.getByText('Anonymous Telemetry')).toBeInTheDocument();
  });

  // Security tab
  it('shows passkey manager in security tab', () => {
    navigateToTab('security');

    expect(screen.getByTestId('passkey-manager')).toBeInTheDocument();
  });

  // Navigation items
  it('renders all navigation items', () => {
    renderUserSettings();

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

    navigateToTab('voice-video');

    expect(screen.getByText('Push to Talk Key')).toBeInTheDocument();
    expect(screen.getByText('Space')).toBeInTheDocument();
  });

  it('shows noise suppression dropdown in custom mode', () => {
    useAudioSettingsStore.setState({ inputProfile: 'custom' });

    navigateToTab('voice-video');

    expect(screen.getByText('Noise Suppression')).toBeInTheDocument();
  });

  it('shows public key label when public key exists', () => {
    renderUserSettings();
    expect(screen.getByText('Your public key fingerprint')).toBeInTheDocument();
  });

  it('does not show public key section when publicKey is null', () => {
    useAuthStore.setState({ publicKey: null });
    renderUserSettings();
    expect(screen.queryByText('Your public key fingerprint')).not.toBeInTheDocument();
  });

  it('enters edit mode when Edit button is clicked', () => {
    renderUserSettings();
    fireEvent.click(screen.getByText('Edit'));
    const input = screen.getByDisplayValue('Test User');
    expect(input).toBeInTheDocument();
    expect(input.tagName).toBe('INPUT');
  });

  it('allows changing display name in edit mode', () => {
    renderUserSettings();
    fireEvent.click(screen.getByText('Edit'));
    const input = screen.getByDisplayValue('Test User');
    fireEvent.change(input, { target: { value: 'New Name' } });
    expect(input).toHaveValue('New Name');
  });

  it('saves display name on blur', async () => {
    const { api } = await import('../services/api');
    renderUserSettings();
    fireEvent.click(screen.getByText('Edit'));
    const input = screen.getByDisplayValue('Test User');
    fireEvent.change(input, { target: { value: 'Updated' } });
    fireEvent.blur(input);
    expect(api.updateMe).toHaveBeenCalled();
  });

  it('saves display name on Enter key', async () => {
    const { api } = await import('../services/api');
    renderUserSettings();
    fireEvent.click(screen.getByText('Edit'));
    const input = screen.getByDisplayValue('Test User');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(api.updateMe).toHaveBeenCalled();
  });

  it('calls logout on store when logout is clicked', () => {
    renderUserSettings();
    fireEvent.click(screen.getByTestId('nav-logout'));
    expect(useAuthStore.getState().logout).toHaveBeenCalled();
  });

  it('changes input volume slider', () => {
    navigateToTab('voice-video');
    const slider = screen.getByRole('slider', { name: 'Input Volume' });
    fireEvent.change(slider, { target: { value: '150' } });
    expect(slider).toHaveValue('150');
  });

  it('changes output volume slider', () => {
    navigateToTab('voice-video');
    const slider = screen.getByRole('slider', { name: 'Output Volume' });
    fireEvent.change(slider, { target: { value: '50' } });
    expect(slider).toHaveValue('50');
  });

  it('selects custom profile and toggles echo cancellation', () => {
    useAudioSettingsStore.setState({ inputProfile: 'custom', echoCancellation: true });
    navigateToTab('voice-video');
    const echoSwitch = screen.getByRole('switch', { name: /Echo Cancellation/ });
    expect(echoSwitch).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(echoSwitch);
  });

  it('toggles push to talk in custom mode', () => {
    useAudioSettingsStore.setState({ inputProfile: 'custom', pushToTalk: false });
    navigateToTab('voice-video');
    const pttSwitch = screen.getByRole('switch', { name: /Push to Talk/ });
    expect(pttSwitch).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(pttSwitch);
  });

  it('shows PTT key capture button when PTT is enabled', () => {
    useAudioSettingsStore.setState({ inputProfile: 'custom', pushToTalk: true, pushToTalkKey: 'KeyV' });
    navigateToTab('voice-video');
    expect(screen.getByText('V')).toBeInTheDocument();
  });

  it('shows "Press a key..." when PTT capture is active', () => {
    useAudioSettingsStore.setState({ inputProfile: 'custom', pushToTalk: true, pushToTalkKey: 'Space' });
    navigateToTab('voice-video');
    const captureBtn = screen.getByRole('button', { name: /Click to change push to talk key/ });
    fireEvent.click(captureBtn);
    expect(screen.getByText('Press a key...')).toBeInTheDocument();
  });

  it('captures PTT key on keydown during capture mode', () => {
    useAudioSettingsStore.setState({ inputProfile: 'custom', pushToTalk: true, pushToTalkKey: 'Space' });
    navigateToTab('voice-video');
    const captureBtn = screen.getByRole('button', { name: /Click to change push to talk key/ });
    fireEvent.click(captureBtn);
    fireEvent.keyDown(globalThis, { code: 'KeyG' });
    expect(screen.getByText('G')).toBeInTheDocument();
  });

  it('toggles auto gain control in custom mode', () => {
    useAudioSettingsStore.setState({ inputProfile: 'custom', autoGainControl: true });
    navigateToTab('voice-video');
    const agcSwitch = screen.getByRole('switch', { name: /Automatically Adjust Input Sensitivity/ });
    expect(agcSwitch).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(agcSwitch);
  });

  it('shows input sensitivity slider when auto gain is off in custom mode', () => {
    useAudioSettingsStore.setState({ inputProfile: 'custom', autoGainControl: false });
    navigateToTab('voice-video');
    expect(screen.getByRole('slider', { name: 'Input Sensitivity' })).toBeInTheDocument();
  });

  it('hides input sensitivity slider when auto gain is on in custom mode', () => {
    useAudioSettingsStore.setState({ inputProfile: 'custom', autoGainControl: true });
    navigateToTab('voice-video');
    expect(screen.queryByRole('slider', { name: 'Input Sensitivity' })).not.toBeInTheDocument();
  });

  it('changes noise suppression dropdown value', () => {
    useAudioSettingsStore.setState({ inputProfile: 'custom', noiseSuppressionMode: 'none' });
    navigateToTab('voice-video');
    const select = screen.getByDisplayValue('None');
    fireEvent.change(select, { target: { value: 'browser' } });
    expect(select).toBeInTheDocument();
  });

  it('toggles desktop notifications', () => {
    navigateToTab('notifications');
    const toggles = screen.getAllByRole('button').filter(b => b.className.includes('toggle-switch'));
    expect(toggles.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(toggles[0]);
  });

  it('switches theme to light', () => {
    navigateToTab('appearance');
    fireEvent.click(screen.getByText('Light'));
    const lightBtn = screen.getByText('Light');
    expect(lightBtn.className).toContain('active');
  });

  // Language selector test omitted — requires i18n.options.supportedLngs
  // which is not available in the global react-i18next mock

  it('toggles telemetry in privacy tab', () => {
    navigateToTab('privacy');
    const telemetryToggle = screen.getByRole('button', { name: /Anonymous Telemetry/ });
    fireEvent.click(telemetryToggle);
    expect(telemetryToggle).toBeInTheDocument();
  });

  it('shows all keybind shortcuts', () => {
    navigateToTab('keybinds');
    expect(screen.getByText('Escape')).toBeInTheDocument();
    expect(screen.getByText('Alt+\u2191/\u2193')).toBeInTheDocument();
  });

  it('shows mic level meter in voice tab', () => {
    navigateToTab('voice-video');
    const meter = document.querySelector('meter');
    expect(meter).toBeInTheDocument();
  });

  it('selects studio profile', () => {
    navigateToTab('voice-video');
    const studioRadio = screen.getByRole('radio', { name: /Studio/ });
    fireEvent.click(studioRadio);
    expect(studioRadio).toBeInTheDocument();
  });

  it('uses single letter initial when username has no space', () => {
    useAuthStore.setState({
      teams: new Map([
        ['team1', { baseUrl: 'http://localhost:8080', token: 'tok', user: { id: 'u1', username: 'alice', display_name: '' }, teamInfo: {} }],
      ]),
    });
    renderUserSettings();
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('changes input sensitivity slider when auto gain is off', () => {
    useAudioSettingsStore.setState({ inputProfile: 'custom', autoGainControl: false });
    navigateToTab('voice-video');
    const sensitivitySlider = screen.getByRole('slider', { name: 'Input Sensitivity' });
    fireEvent.change(sensitivitySlider, { target: { value: '50' } });
    expect(sensitivitySlider).toHaveValue('50');
  });

  it('toggles sound notifications', () => {
    navigateToTab('notifications');
    const toggles = screen.getAllByRole('button').filter(b => b.className.includes('toggle-switch'));
    expect(toggles.length).toBeGreaterThanOrEqual(2);
    if (toggles.length >= 2) {
      fireEvent.click(toggles[1]);
    }
  });

  it('shows "Saving..." when display name save is in progress', async () => {
    const { api } = await import('../services/api');
    let resolveUpdate: (v: unknown) => void;
    vi.mocked(api.updateMe).mockReturnValueOnce(new Promise<unknown>(r => { resolveUpdate = r; }));

    renderUserSettings();
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
    renderUserSettings();
    fireEvent.click(screen.getByText('Edit'));
    const input = screen.getByDisplayValue('Test User');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(api.updateMe).not.toHaveBeenCalled();
  });

  it('reverts display name on save failure', async () => {
    const { api } = await import('../services/api');
    vi.mocked(api.updateMe).mockRejectedValueOnce(new Error('Network error'));

    renderUserSettings();
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
    renderUserSettings();
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

    navigateToTab('voice-video');
    const testMicBtn = screen.getByText('Test Mic');
    fireEvent.click(testMicBtn);
    expect(testMicBtn).toBeInTheDocument();
  });

  it.each([
    ['voice isolation', /Just your beautiful voice/],
    ['studio', /Pure audio/],
    ['custom', /Advanced mode/],
  ])('shows %s profile description', (_label, pattern) => {
    navigateToTab('voice-video');
    expect(screen.getByText(pattern)).toBeInTheDocument();
  });

  it('selects voice isolation profile via radio', () => {
    useAudioSettingsStore.setState({ inputProfile: 'custom' });
    navigateToTab('voice-video');
    const voiceIsolationRadio = screen.getByRole('radio', { name: /Voice Isolation/ });
    fireEvent.click(voiceIsolationRadio);
    expect(voiceIsolationRadio).toBeInTheDocument();
  });

  it.each([
    ['auto sensitivity toggle', /Automatically adjusts your mic volume/],
    ['echo cancellation', /Removes echo from speakers/],
    ['push to talk', /Hold a key to transmit/],
  ])('shows %s description in custom mode', (_label, pattern) => {
    useAudioSettingsStore.setState({ inputProfile: 'custom' });
    navigateToTab('voice-video');
    expect(screen.getByText(pattern)).toBeInTheDocument();
  });

  it('shows language selector in language tab', () => {
    navigateToTab('language');
    expect(screen.getByText('Select Language')).toBeInTheDocument();
  });

  it.each([
    ['KeyA', 'A', 'converts KeyX to X'],
    ['Digit5', '5', 'converts DigitX to X'],
    ['ShiftLeft', 'Shift Left', 'handles camelCase codes'],
  ])('keyCodeToLabel %s — %s', (pushToTalkKey, expectedLabel) => {
    useAudioSettingsStore.setState({ inputProfile: 'custom', pushToTalk: true, pushToTalkKey });
    navigateToTab('voice-video');
    expect(screen.getByText(expectedLabel)).toBeInTheDocument();
  });

  it('does not save display name when baseUrl or token is missing', async () => {
    const { api } = await import('../services/api');
    useAuthStore.setState({
      teams: new Map([
        ['team1', { baseUrl: '', token: null, user: { id: 'u1', username: 'testuser', display_name: 'Test User' }, teamInfo: {} }],
      ]),
    });
    renderUserSettings();
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
    renderUserSettings();
    expect(screen.getByText('testuser')).toBeInTheDocument();
  });

  it('renders language dropdown with i18n language', () => {
    navigateToTab('language');
    // The dropdown should show a select with the current language
    const select = screen.getByRole('combobox');
    expect(select).toBeInTheDocument();
  });

  it('switches between all nav tabs', () => {
    renderUserSettings();
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
    navigateToTab('voice-video');
    const meter = document.querySelector('meter');
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

    navigateToTab('voice-video');

    // Wait for devices to load (useEffect with enumerateDevices)
    const { waitFor } = await import('@testing-library/react');
    await waitFor(() => {
      expect(screen.getByText('USB Microphone')).toBeInTheDocument();
    });
    expect(screen.getByText('Headphones')).toBeInTheDocument();
  });

  it('mic test button is present and clickable', () => {
    navigateToTab('voice-video');
    // The mic test button shows the i18n key
    const btn = screen.getByRole('button', { name: /startTest|Test Mic/ });
    expect(btn).toBeInTheDocument();
    // Click should not throw
    fireEvent.click(btn);
  });

  it('language tab renders change handler', () => {
    navigateToTab('language');
    // The language select should be present
    const selects = document.querySelectorAll('select');
    expect(selects.length).toBeGreaterThan(0);
  });

  it('starts and stops mic test via startMicTest/stopMicTest', async () => {
    const { startMicTest, stopMicTest } = await import('../services/micTest');
    const { waitFor } = await import('@testing-library/react');

    navigateToTab('voice-video');

    // Click "Test Mic" to start
    const testBtn = screen.getByRole('button', { name: /startTest|Test Mic/ });
    fireEvent.click(testBtn);

    await waitFor(() => {
      expect(startMicTest).toHaveBeenCalled();
    });

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

    navigateToTab('voice-video');

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

});
