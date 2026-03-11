import { useState, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import SettingsLayout, { type NavSection } from '../components/SettingsLayout/SettingsLayout';
import PasskeyManager from '../components/PasskeyManager/PasskeyManager';
import { useAuthStore } from '../stores/authStore';
import { useAudioSettingsStore } from '../stores/audioSettingsStore';
import './UserSettings.css';

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent);
const mod = isMac ? '⌘' : 'Ctrl';

const shortcuts = [
  { key: `${mod}+K`, action: 'shortcuts.search' },
  { key: 'Escape', action: 'shortcuts.closePanel' },
  { key: `${mod}+Shift+M`, action: 'shortcuts.toggleMute' },
  { key: `${mod}+Shift+D`, action: 'shortcuts.toggleDeafen' },
  { key: 'Alt+↑/↓', action: 'shortcuts.navigateChannels' },
  { key: `${mod}+/`, action: 'shortcuts.showShortcuts' },
];

export default function UserSettings() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { publicKey, logout, teams } = useAuthStore();
  const {
    echoCancellation, noiseSuppression, autoGainControl,
    setEchoCancellation, setNoiseSuppression, setAutoGainControl,
  } = useAudioSettingsStore();
  const [activeId, setActiveId] = useState('my-account');

  // User info from first team entry
  const userInfo = useMemo(() => {
    const first = teams.values().next().value as { user?: { username?: string; display_name?: string } } | undefined;
    return {
      username: (first?.user as { username?: string })?.username ?? 'user',
      displayName: (first?.user as { display_name?: string })?.display_name ?? '',
    };
  }, [teams]);

  const [editingName, setEditingName] = useState(false);
  const [displayName, setDisplayName] = useState(userInfo.displayName);

  // Notification toggles (client-side only)
  const [desktopNotifs, setDesktopNotifs] = useState(true);
  const [soundNotifs, setSoundNotifs] = useState(true);

  // Audio devices
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedInput, setSelectedInput] = useState('default');
  const [selectedOutput, setSelectedOutput] = useState('default');
  const [inputThreshold, setInputThreshold] = useState(0.15);

  useEffect(() => {
    async function enumerateDevices() {
      try {
        // Request permission first so labels are populated
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
          { id: 'keybinds', label: t('userSettings.keybinds', 'Keybinds') },
          { id: 'language', label: t('userSettings.language', 'Language') },
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
                    onBlur={() => setEditingName(false)}
                    onKeyDown={(e) => e.key === 'Enter' && setEditingName(false)}
                    autoFocus
                  />
                ) : (
                  <span>{displayName || userInfo.username}</span>
                )}
              </div>
              <div className="user-profile-username">@{userInfo.username}</div>
            </div>
            <button className="btn-secondary" onClick={() => setEditingName(!editingName)}>
              {t('common.edit', 'Edit')}
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

          <div className="settings-field">
            <label>{t('userSettings.inputDevice', 'Input Device')}</label>
            <select value={selectedInput} onChange={(e) => setSelectedInput(e.target.value)}>
              <option value="default">{t('userSettings.defaultDevice', 'Default')}</option>
              {inputDevices.filter((d) => d.deviceId !== 'default').map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Microphone (${d.deviceId.slice(0, 8)})`}
                </option>
              ))}
            </select>
          </div>

          <MicTest deviceId={selectedInput} threshold={inputThreshold} onThresholdChange={setInputThreshold} disabled={autoGainControl} />

          <div className="settings-field">
            <label>{t('userSettings.outputDevice', 'Output Device')}</label>
            <select value={selectedOutput} onChange={(e) => setSelectedOutput(e.target.value)}>
              <option value="default">{t('userSettings.defaultDevice', 'Default')}</option>
              {outputDevices.filter((d) => d.deviceId !== 'default').map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Speaker (${d.deviceId.slice(0, 8)})`}
                </option>
              ))}
            </select>
          </div>

          <h3 className="voice-processing-heading">{t('userSettings.voiceProcessing', 'Voice Processing')}</h3>

          <div className="settings-toggle">
            <div className="settings-toggle-info">
              <div className="settings-toggle-label">{t('userSettings.echoCancellation', 'Echo Cancellation')}</div>
              <div className="settings-toggle-description">{t('userSettings.echoCancellationDesc', 'Removes echo from speakers being picked up by your mic')}</div>
            </div>
            <button className={`toggle-switch ${echoCancellation ? 'active' : ''}`} onClick={() => setEchoCancellation(!echoCancellation)} />
          </div>

          <div className="settings-toggle">
            <div className="settings-toggle-info">
              <div className="settings-toggle-label">{t('userSettings.noiseSuppression', 'Noise Suppression')}</div>
              <div className="settings-toggle-description">{t('userSettings.noiseSuppressionDesc', 'Filters background noise like fans, keyboard clicks, and ambient sound')}</div>
            </div>
            <button className={`toggle-switch ${noiseSuppression ? 'active' : ''}`} onClick={() => setNoiseSuppression(!noiseSuppression)} />
          </div>

          <div className="settings-toggle">
            <div className="settings-toggle-info">
              <div className="settings-toggle-label">{t('userSettings.autoGainControl', 'Automatic Gain Control')}</div>
              <div className="settings-toggle-description">{t('userSettings.autoGainControlDesc', 'Automatically adjusts your mic volume to a consistent level')}</div>
            </div>
            <button className={`toggle-switch ${autoGainControl ? 'active' : ''}`} onClick={() => setAutoGainControl(!autoGainControl)} />
          </div>
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
              className={`toggle-switch ${desktopNotifs ? 'active' : ''}`}
              onClick={() => setDesktopNotifs(!desktopNotifs)}
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
              className={`toggle-switch ${soundNotifs ? 'active' : ''}`}
              onClick={() => setSoundNotifs(!soundNotifs)}
            />
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
              {(i18n.options.supportedLngs
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

      {activeId === 'security' && (
        <div className="settings-section">
          <h2>{t('userSettings.security', 'Security')}</h2>
          <PasskeyManager />
        </div>
      )}
    </SettingsLayout>
  );
}

/* ─── Mic Test Component ─── */
function MicTest({ deviceId, threshold, onThresholdChange, disabled }: { deviceId: string; threshold: number; onThresholdChange: (v: number) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const animRef = useRef<number>(0);

  const startTest = async () => {
    try {
      const audioConstraints = useAudioSettingsStore.getState().getAudioConstraints(deviceId);
      const constraints: MediaStreamConstraints = {
        audio: audioConstraints,
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;

      const audioCtx = new AudioContext();
      ctxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.3;
      source.connect(analyser);

      const timeDomain = new Float32Array(analyser.fftSize);
      const update = () => {
        analyser.getFloatTimeDomainData(timeDomain);
        let sum = 0;
        for (let i = 0; i < timeDomain.length; i++) {
          sum += timeDomain[i] * timeDomain[i];
        }
        const rms = Math.sqrt(sum / timeDomain.length);
        const scaled = Math.min(rms * 4, 1);
        setLevel(scaled);
        animRef.current = requestAnimationFrame(update);
      };
      update();
      setTesting(true);
    } catch {
      // Permission denied
    }
  };

  const stopTest = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (ctxRef.current) {
      ctxRef.current.close();
      ctxRef.current = null;
    }
    cancelAnimationFrame(animRef.current);
    setLevel(0);
    setTesting(false);
  };

  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
      if (ctxRef.current) {
        ctxRef.current.close();
      }
      cancelAnimationFrame(animRef.current);
    };
  }, []);

  const thresholdPos = threshold * 100;

  return (
    <div className="mic-test">
      <div className="mic-test-header">
        <label>{t('userSettings.micTest', 'Mic Test')}</label>
        <button
          className={testing ? 'btn-danger' : 'btn-secondary'}
          onClick={testing ? stopTest : startTest}
        >
          {testing ? t('userSettings.stopTest', 'Stop') : t('userSettings.startTest', 'Test Mic')}
        </button>
      </div>
      <div className={`mic-threshold ${disabled ? 'disabled' : ''}`}>
        <label>{t('userSettings.inputSensitivity', 'Input Sensitivity')}</label>
        <div className="mic-threshold-auto-label" style={{ visibility: disabled ? 'visible' : 'hidden', height: disabled ? undefined : 0 }}>
          {t('userSettings.autoSensitivity', 'Automatically adjusted by Automatic Gain Control')}
        </div>
        <div className="mic-threshold-track">
          <div
            className={`mic-threshold-level ${!disabled && level > threshold ? 'above' : ''}`}
            style={{ width: `${level * 100}%` }}
          />
          <input
            type="range"
            min="0"
            max="100"
            value={Math.round(threshold * 100)}
            onChange={(e) => onThresholdChange(Number(e.target.value) / 100)}
            className="mic-threshold-slider"
            disabled={disabled}
          />
        </div>
        <div className="mic-threshold-labels">
          <span style={{ visibility: disabled ? 'hidden' : 'visible' }}>{t('userSettings.sensitive', 'Sensitive')}</span>
          <span style={{ visibility: disabled ? 'hidden' : 'visible' }}>{t('userSettings.noisy', 'Noisy')}</span>
        </div>
      </div>
    </div>
  );
}
