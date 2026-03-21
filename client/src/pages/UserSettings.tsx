import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import SettingsLayout, { type NavSection } from '../components/SettingsLayout/SettingsLayout';
import PasskeyManager from '../components/PasskeyManager/PasskeyManager';
import { useAuthStore } from '../stores/authStore';
import { useAudioSettingsStore, type InputProfile, type NoiseSuppressionMode } from '../stores/audioSettingsStore';
import { useUserSettingsStore } from '../stores/userSettingsStore';
import { useTelemetryStore } from '../stores/telemetryStore';
import { notificationService } from '../services/notifications';
import { api } from '../services/api';
import { startMicTest, stopMicTest, type MicTestSession } from '../services/micTest';
import { shortcuts } from '../utils/keyboardShortcuts';
import './UserSettings.css';

/** Maps KeyboardEvent.code to a readable label */
function keyCodeToLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code.replaceAll(/([a-z])([A-Z])/g, '$1 $2');
}

export default function UserSettings() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { publicKey, logout, teams } = useAuthStore();
  const {
    echoCancellation, autoGainControl,
    inputProfile, noiseSuppressionMode, pushToTalk, pushToTalkKey,
    setEchoCancellation, setAutoGainControl,
    setInputProfile, setNoiseSuppressionMode, setPushToTalk, setPushToTalkKey,
  } = useAudioSettingsStore();
  const {
    selectedInputDevice, selectedOutputDevice, inputThreshold,
    inputVolume, outputVolume,
    desktopNotifications, soundNotifications, theme,
    setSelectedInputDevice, setSelectedOutputDevice, setInputThreshold,
    setInputVolume, setOutputVolume,
    setDesktopNotifications, setSoundNotifications, setTheme,
  } = useUserSettingsStore();
  const { enabled: telemetryEnabled, setEnabled: setTelemetryEnabled } = useTelemetryStore();
  const [activeId, setActiveId] = useState('my-account');

  // User info from first team entry
  const userInfo = useMemo(() => {
    const first = teams.values().next().value;
    return {
      username: first?.user?.username ?? 'user',
      displayName: first?.user?.display_name ?? '',
      baseUrl: first?.baseUrl ?? '',
      token: first?.token ?? null,
    };
  }, [teams]);

  const [editingName, setEditingName] = useState(false);
  const [displayName, setDisplayName] = useState(userInfo.displayName);
  const [savingName, setSavingName] = useState(false);

  // Audio devices
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);

  // PTT key capture
  const [capturingKey, setCapturingKey] = useState(false);

  // Sync notification service with store
  useEffect(() => {
    notificationService.setEnabled(desktopNotifications);
  }, [desktopNotifications]);

  useEffect(() => {
    async function enumerateDevices() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());

        const devices = await navigator.mediaDevices.enumerateDevices();
        setInputDevices(devices.filter((d) => d.kind === 'audioinput'));
        setOutputDevices(devices.filter((d) => d.kind === 'audiooutput'));
      } catch {
        // Permission denied or no devices
      }
    }
    if (activeId === 'voice-video') enumerateDevices();
  }, [activeId]);

  // PTT key capture handler
  useEffect(() => {
    if (!capturingKey) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setPushToTalkKey(e.code);
      setCapturingKey(false);
    };
    globalThis.addEventListener('keydown', handler, true);
    return () => globalThis.removeEventListener('keydown', handler, true);
  }, [capturingKey, setPushToTalkKey]);

  const saveDisplayName = async () => {
    if (!displayName || savingName) return;
    setSavingName(true);
    try {
      if (userInfo.baseUrl && userInfo.token) {
        const updatedUser = await api.updateMe(userInfo.baseUrl, userInfo.token, { display_name: displayName });
        const firstTeamId = teams.keys().next().value;
        if (firstTeamId && updatedUser) {
          useAuthStore.getState().updateTeamUser(firstTeamId as string, updatedUser as Record<string, unknown>);
        }
      }
    } catch {
      // Revert on failure
      setDisplayName(userInfo.displayName);
    } finally {
      setSavingName(false);
      setEditingName(false);
    }
  };

  const sections: NavSection[] = useMemo(
    () => [
      {
        items: [{ id: 'my-account', label: t('userSettings.myAccount', 'My Account') }],
      },
      {
        label: t('userSettings.appSettings', 'APP SETTINGS'),
        items: [
          { id: 'voice-video', label: t('userSettings.voiceVideo', 'Voice & Video') },
          { id: 'notifications', label: t('userSettings.notifications', 'Notifications') },
          { id: 'appearance', label: t('userSettings.appearance', 'Appearance') },
          { id: 'keybinds', label: t('userSettings.keybinds', 'Keybinds') },
          { id: 'language', label: t('userSettings.language', 'Language') },
          { id: 'privacy', label: t('userSettings.privacy', 'Privacy') },
        ],
      },
      {
        items: [{ id: 'security', label: t('userSettings.security', 'Security') }],
      },
      {
        items: [{ id: 'logout', label: t('userSettings.logOut', 'Log Out'), danger: true }],
      },
    ],
    [t],
  );

  const handleSelect = (id: string) => {
    if (id === 'logout') {
      logout();
      navigate('/welcome');
      return;
    }
    setActiveId(id);
  };

  const handleClose = () => navigate('/app');

  const initials = (displayName || userInfo.username)
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  const isCustomProfile = inputProfile === 'custom';

  return (
    <SettingsLayout
      sections={sections}
      activeId={activeId}
      onSelect={handleSelect}
      onClose={handleClose}
    >
      {activeId === 'my-account' && (
        <div className="settings-section">
          <h2>{t('userSettings.myAccount', 'My Account')}</h2>
          <div className="user-profile-card">
            <div className="user-profile-avatar">{initials}</div>
            <div className="user-profile-info">
              <div className="user-profile-display-name">
                {editingName ? (
                  <input
                    className="user-profile-name-input"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    onBlur={() => saveDisplayName()}
                    onKeyDown={(e) => e.key === 'Enter' && saveDisplayName()}
                    autoFocus
                  />
                ) : (
                  <span>{displayName || userInfo.username}</span>
                )}
              </div>
              <div className="user-profile-username">@{userInfo.username}</div>
            </div>
            <button className="btn-secondary" onClick={() => setEditingName(!editingName)} disabled={savingName}>
              {savingName ? t('common.saving', 'Saving...') : t('common.edit', 'Edit')}
            </button>
          </div>

          {publicKey && (
            <div className="settings-field" style={{ marginTop: 20 }}>
              <label>{t('identity.publicKeyLabel', 'Your public key fingerprint')}</label>
              <div className="user-public-key">{publicKey}</div>
            </div>
          )}
        </div>
      )}

      {activeId === 'voice-video' && (
        <div className="settings-section">
          <h2>{t('userSettings.voiceVideo', 'Voice & Video')}</h2>

          {/* Side-by-side device selectors */}
          <div className="voice-device-row">
            <div className="settings-field" style={{ flex: 1 }}>
              <label>{t('userSettings.inputDevice', 'Input Device')}</label>
              <select value={selectedInputDevice} onChange={(e) => setSelectedInputDevice(e.target.value)}>
                <option value="default">{t('userSettings.defaultDevice', 'Default')}</option>
                {inputDevices.filter((d) => d.deviceId !== 'default').map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Microphone (${d.deviceId.slice(0, 8)})`}
                  </option>
                ))}
              </select>
            </div>
            <div className="settings-field" style={{ flex: 1 }}>
              <label>{t('userSettings.outputDevice', 'Output Device')}</label>
              <select value={selectedOutputDevice} onChange={(e) => setSelectedOutputDevice(e.target.value)}>
                <option value="default">{t('userSettings.defaultDevice', 'Default')}</option>
                {outputDevices.filter((d) => d.deviceId !== 'default').map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Speaker (${d.deviceId.slice(0, 8)})`}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Side-by-side volume sliders */}
          <div className="voice-device-row">
            <div className="settings-field" style={{ flex: 1 }}>
              <label>{t('userSettings.inputVolume', 'Input Volume')}</label>
              <input
                type="range"
                min="0"
                max="200"
                value={Math.round(inputVolume * 100)}
                onChange={(e) => setInputVolume(Number(e.target.value) / 100)}
                className="voice-volume-slider"
                aria-label={t('userSettings.inputVolume', 'Input Volume')}
                aria-valuemin={0}
                aria-valuemax={200}
                aria-valuenow={Math.round(inputVolume * 100)}
              />
              <span className="voice-volume-label">{Math.round(inputVolume * 100)}%</span>
            </div>
            <div className="settings-field" style={{ flex: 1 }}>
              <label>{t('userSettings.outputVolume', 'Output Volume')}</label>
              <input
                type="range"
                min="0"
                max="100"
                value={Math.round(outputVolume * 100)}
                onChange={(e) => setOutputVolume(Number(e.target.value) / 100)}
                className="voice-volume-slider"
                aria-label={t('userSettings.outputVolume', 'Output Volume')}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(outputVolume * 100)}
              />
              <span className="voice-volume-label">{Math.round(outputVolume * 100)}%</span>
            </div>
          </div>

          {/* Mic test */}
          <MicTest deviceId={selectedInputDevice} inputVolume={inputVolume} />

          <div className="voice-separator" />

          {/* Input Profile radio group */}
          <h3 className="voice-processing-heading">{t('userSettings.inputProfile', 'Input Profile')}</h3>
          <div className="voice-profile-group" role="radiogroup" aria-label={t('userSettings.inputProfile', 'Input Profile')}>
            <ProfileOption
              value="voice-isolation"
              selected={inputProfile}
              onChange={setInputProfile}
              name={t('userSettings.profileVoiceIsolation', 'Voice Isolation')}
              desc={t('userSettings.profileVoiceIsolationDesc', 'Just your beautiful voice: let Dilla cut through the noise')}
            />
            <ProfileOption
              value="studio"
              selected={inputProfile}
              onChange={setInputProfile}
              name={t('userSettings.profileStudio', 'Studio')}
              desc={t('userSettings.profileStudioDesc', 'Pure audio: open mic with no processing')}
            />
            <ProfileOption
              value="custom"
              selected={inputProfile}
              onChange={setInputProfile}
              name={t('userSettings.profileCustom', 'Custom')}
              desc={t('userSettings.profileCustomDesc', 'Advanced mode: give me all the buttons and dials!')}
            />
          </div>

          {/* Custom settings — only shown when Custom profile is selected */}
          {isCustomProfile && (
            <div className="voice-custom-settings">
              {/* Auto sensitivity toggle */}
              <div className="settings-toggle">
                <div className="settings-toggle-info">
                  <div className="settings-toggle-label">{t('userSettings.autoSensitivityToggle', 'Automatically Adjust Input Sensitivity')}</div>
                  <div className="settings-toggle-description">{t('userSettings.autoGainControlDesc', 'Automatically adjusts your mic volume to a consistent level')}</div>
                </div>
                <button
                  className={`toggle-switch ${autoGainControl ? 'active' : ''}`}
                  onClick={() => setAutoGainControl(!autoGainControl)}
                  role="switch"
                  aria-checked={autoGainControl}
                  aria-label={t('userSettings.autoSensitivityToggle', 'Automatically Adjust Input Sensitivity')}
                />
              </div>

              {/* Threshold slider — shown when auto sensitivity is OFF */}
              {!autoGainControl && (
                <div className="mic-threshold">
                  <label>{t('userSettings.inputSensitivity', 'Input Sensitivity')}</label>
                  <div className="mic-threshold-track">
                    <div
                      className="mic-threshold-level"
                      style={{ width: `${inputThreshold * 100}%` }}
                    />
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={Math.round(inputThreshold * 100)}
                      onChange={(e) => setInputThreshold(Number(e.target.value) / 100)}
                      className="mic-threshold-slider"
                      aria-label={t('userSettings.inputSensitivity', 'Input Sensitivity')}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(inputThreshold * 100)}
                    />
                  </div>
                  <div className="mic-threshold-labels">
                    <span>{t('userSettings.sensitive', 'Sensitive')}</span>
                    <span>{t('userSettings.noisy', 'Noisy')}</span>
                  </div>
                </div>
              )}

              {/* Noise Suppression dropdown */}
              <div className="settings-field">
                <label>{t('userSettings.noiseSuppression', 'Noise Suppression')}</label>
                <select
                  value={noiseSuppressionMode}
                  onChange={(e) => setNoiseSuppressionMode(e.target.value as NoiseSuppressionMode)}
                >
                  <option value="none">{t('userSettings.nsNone', 'None')}</option>
                  <option value="browser">{t('userSettings.nsBrowser', 'Browser')}</option>
                </select>
              </div>

              {/* Echo Cancellation toggle */}
              <div className="settings-toggle">
                <div className="settings-toggle-info">
                  <div className="settings-toggle-label">{t('userSettings.echoCancellation', 'Echo Cancellation')}</div>
                  <div className="settings-toggle-description">{t('userSettings.echoCancellationDesc', 'Removes echo from speakers being picked up by your mic')}</div>
                </div>
                <button
                  className={`toggle-switch ${echoCancellation ? 'active' : ''}`}
                  onClick={() => setEchoCancellation(!echoCancellation)}
                  role="switch"
                  aria-checked={echoCancellation}
                  aria-label={t('userSettings.echoCancellation', 'Echo Cancellation')}
                />
              </div>

              {/* Push to Talk toggle */}
              <div className="settings-toggle">
                <div className="settings-toggle-info">
                  <div className="settings-toggle-label">{t('userSettings.pushToTalk', 'Push to Talk')}</div>
                  <div className="settings-toggle-description">{t('userSettings.pushToTalkDesc', 'Hold a key to transmit your voice instead of always-on mic')}</div>
                </div>
                <button
                  className={`toggle-switch ${pushToTalk ? 'active' : ''}`}
                  onClick={() => setPushToTalk(!pushToTalk)}
                  role="switch"
                  aria-checked={pushToTalk}
                  aria-label={t('userSettings.pushToTalk', 'Push to Talk')}
                />
              </div>

              {/* PTT key capture — shown when PTT is ON */}
              {pushToTalk && (
                <div className="settings-field">
                  <label>{t('userSettings.pushToTalkKey', 'Push to Talk Key')}</label>
                  <button
                    className="ptt-key-capture"
                    onClick={() => setCapturingKey(true)}
                    aria-label={t('userSettings.pushToTalkKeyCapture', 'Click to change push to talk key')}
                  >
                    {capturingKey
                      ? t('userSettings.pressAKey', 'Press a key...')
                      : keyCodeToLabel(pushToTalkKey)
                    }
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {activeId === 'notifications' && (
        <div className="settings-section">
          <h2>{t('userSettings.notifications', 'Notifications')}</h2>

          <div className="settings-toggle">
            <div className="settings-toggle-info">
              <div className="settings-toggle-label">
                {t('userSettings.desktopNotifs', 'Desktop Notifications')}
              </div>
              <div className="settings-toggle-desc">
                {t('userSettings.desktopNotifsDesc', 'Show desktop notifications for new messages')}
              </div>
            </div>
            <button
              className={`toggle-switch ${desktopNotifications ? 'active' : ''}`}
              onClick={() => setDesktopNotifications(!desktopNotifications)}
            />
          </div>

          <div className="settings-toggle">
            <div className="settings-toggle-info">
              <div className="settings-toggle-label">
                {t('userSettings.soundNotifs', 'Notification Sounds')}
              </div>
              <div className="settings-toggle-desc">
                {t('userSettings.soundNotifsDesc', 'Play a sound when you receive a notification')}
              </div>
            </div>
            <button
              className={`toggle-switch ${soundNotifications ? 'active' : ''}`}
              onClick={() => setSoundNotifications(!soundNotifications)}
            />
          </div>
        </div>
      )}

      {activeId === 'appearance' && (
        <div className="settings-section">
          <h2>{t('userSettings.appearance', 'Appearance')}</h2>

          <div className="settings-toggle">
            <div className="settings-toggle-info">
              <div className="settings-toggle-label">
                {t('userSettings.theme', 'Theme')}
              </div>
              <div className="settings-toggle-description">
                {t('userSettings.themeDesc', 'Choose between dark and light mode')}
              </div>
            </div>
            <div className="theme-toggle-buttons">
              <button
                className={`btn-secondary ${theme === 'dark' ? 'active' : ''}`}
                onClick={() => setTheme('dark')}
              >
                {t('userSettings.dark', 'Dark')}
              </button>
              <button
                className={`btn-secondary ${theme === 'light' ? 'active' : ''}`}
                onClick={() => setTheme('light')}
              >
                {t('userSettings.light', 'Light')}
              </button>
            </div>
          </div>
        </div>
      )}

      {activeId === 'keybinds' && (
        <div className="settings-section">
          <h2>{t('userSettings.keybinds', 'Keybinds')}</h2>
          <div className="keybinds-list">
            {shortcuts.map((s) => (
              <div className="keybind-row" key={s.key}>
                <span className="keybind-action">{t(s.action)}</span>
                <kbd className="keybind-key">{s.key}</kbd>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeId === 'language' && (
        <div className="settings-section">
          <h2>{t('userSettings.language', 'Language')}</h2>
          <div className="settings-field">
            <label>{t('userSettings.selectLanguage', 'Select Language')}</label>
            <select
              value={i18n.language}
              onChange={(e) => i18n.changeLanguage(e.target.value)}
            >
              {/* istanbul ignore next -- i18n.options requires full i18next init */}
              {(i18n.options?.supportedLngs
                ? (i18n.options.supportedLngs as string[]).filter((l) => l !== 'cimode')
                : [i18n.language]
              ).map((lng) => (
                <option key={lng} value={lng}>
                  {lng === 'en' ? 'English' : lng}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {activeId === 'privacy' && (
        <div className="settings-section">
          <h2>{t('userSettings.privacy', 'Privacy')}</h2>

          <div className="settings-toggle">
            <div className="settings-toggle-info">
              <div className="settings-toggle-label">
                {t('userSettings.telemetry', 'Anonymous Telemetry')}
              </div>
              <div className="settings-toggle-description">
                {t(
                  'userSettings.telemetryDesc',
                  'Help improve Dilla by sharing anonymous usage data (page load times, error counts). No message content, usernames, or IP addresses are ever collected.',
                )}
              </div>
            </div>
            <button
              className={`toggle-switch ${telemetryEnabled ? 'active' : ''}`}
              onClick={() => setTelemetryEnabled(!telemetryEnabled)}
              aria-label={t('userSettings.telemetry', 'Anonymous Telemetry')}
            />
          </div>
        </div>
      )}

      {activeId === 'security' && (
        <div className="settings-section">
          <h2>{t('userSettings.security', 'Security')}</h2>
          <PasskeyManager />
        </div>
      )}
    </SettingsLayout>
  );
}

/* ─── Profile Option Component ─── */
function ProfileOption({ value, selected, onChange, name, desc }: Readonly<{
  value: InputProfile;
  selected: InputProfile;
  onChange: (v: InputProfile) => void;
  name: string;
  desc: string;
}>) {
  const isSelected = selected === value;
  return (
    <label className={`voice-profile-option ${isSelected ? 'selected' : ''}`} aria-label={name}>
      <input
        type="radio"
        name="input-profile"
        value={value}
        checked={isSelected}
        onChange={() => onChange(value)}
      />
      <div>
        <div className="voice-profile-name">{name}</div>
        <div className="voice-profile-desc">{desc}</div>
      </div>
    </label>
  );
}

/* ─── Mic Test Component ─── */
function MicTest({ deviceId, inputVolume }: Readonly<{ deviceId: string; inputVolume: number }>) {
  const { t } = useTranslation();
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const sessionRef = useRef<MicTestSession | null>(null);

  // Update gain when inputVolume changes during test
  useEffect(() => {
    if (sessionRef.current) {
      sessionRef.current.gainNode.gain.value = inputVolume;
    }
  }, [inputVolume]);

  const handleStop = useCallback(() => {
    stopMicTest(sessionRef.current);
    sessionRef.current = null;
    setLevel(0);
    setTesting(false);
  }, []);

  const handleStart = useCallback(async () => {
    try {
      const audioConstraints = useAudioSettingsStore.getState().getAudioConstraints(deviceId);
      const session = await startMicTest({
        audioConstraints,
        inputVolume,
        onLevelUpdate: setLevel,
      });
      sessionRef.current = session;
      setTesting(true);
    } catch {
      // Permission denied
    }
  }, [deviceId, inputVolume]);

  useEffect(() => {
    return () => {
      stopMicTest(sessionRef.current);
    };
  }, []);

  return (
    <div className="voice-mic-test-row">
      <button
        className={testing ? 'btn-danger' : 'btn-secondary'}
        onClick={testing ? handleStop : handleStart}
      >
        {testing ? t('userSettings.stopTest', 'Stop') : t('userSettings.startTest', 'Test Mic')}
      </button>
      <meter
        className="voice-level-bar"
        aria-label={t('userSettings.micLevel', 'Microphone level')}
        min={0}
        max={100}
        value={Math.round(level * 100)}
      />
    </div>
  );
}
