import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  IconPhoneOff,
  IconScreenShare,
  IconVideo,
  IconVideoOff,
  IconWaveSine,
} from '@tabler/icons-react';
import { useVoiceConnection } from '../../hooks/useVoiceConnection';
import { useVoiceMediaState } from '../../stores/selectors';
import { useAudioSettingsStore } from '../../stores/audioSettingsStore';
import { useTeamStore, type Channel } from '../../stores/teamStore';
import {
  diagnostics,
  type DiagnosticsSnapshot,
} from '../../services/voiceIsolation/diagnostics';
import ConnectionStatus from '../ConnectionStatus/ConnectionStatus';
import './VoiceControls.css';

export default function VoiceControls() {
  const { t } = useTranslation();
  const { currentChannelId, currentTeamId, connected, connecting, leave } = useVoiceConnection();
  const { screenSharing, webcamSharing } = useVoiceMediaState();
  const noiseSuppressionActive = useAudioSettingsStore((s) => s.noiseSuppression);

  const { channels, teams } = useTeamStore();

  const [nsPopoverOpen, setNsPopoverOpen] = useState(false);
  const [nsSnapshot, setNsSnapshot] = useState<DiagnosticsSnapshot | null>(null);
  const nsContainerRef = useRef<HTMLDivElement | null>(null);

  // Refresh the diagnostics snapshot on a 1Hz tick while the popover is open.
  useEffect(() => {
    if (!nsPopoverOpen) return;
    setNsSnapshot(diagnostics.snapshot());
    const id = window.setInterval(() => {
      setNsSnapshot(diagnostics.snapshot());
    }, 1000);
    return () => window.clearInterval(id);
  }, [nsPopoverOpen]);

  // Click-outside-to-dismiss for the popover.
  useEffect(() => {
    if (!nsPopoverOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!nsContainerRef.current) return;
      if (!nsContainerRef.current.contains(e.target as Node)) {
        setNsPopoverOpen(false);
      }
    };
    // Defer attachment so the click that opened the popover doesn't close it.
    const id = window.setTimeout(
      () => document.addEventListener('mousedown', onDocClick),
      0,
    );
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('mousedown', onDocClick);
    };
  }, [nsPopoverOpen]);

  if (!connected && !connecting) return null;

  const teamChannels = currentTeamId ? (channels?.get(currentTeamId) ?? []) : [];
  const channel: Channel | undefined = teamChannels.find((c) => c.id === currentChannelId);
  const teamName = currentTeamId ? teams?.get(currentTeamId)?.name : null;

  const handleScreenShare = async () => {
    const { webrtcService } = await import('../../services/webrtc');
    if (screenSharing) {
      await webrtcService.stopScreenShare();
    } else {
      try {
        await webrtcService.startScreenShare();
      } catch (err) {
        console.warn('[Voice] Screen share failed:', err);
      }
    }
  };

  const handleWebcam = async () => {
    const { webrtcService } = await import('../../services/webrtc');
    if (webcamSharing) {
      await webrtcService.stopWebcam();
    } else {
      try {
        await webrtcService.startWebcam();
      } catch (err) {
        console.warn('[Voice] Webcam failed:', err);
      }
    }
  };

  return (
    <div className="voice-controls">
      <div className="voice-controls-row">
        <div className="voice-controls-left">
          <div className="voice-controls-title">
            <ConnectionStatus />
            <span className="voice-controls-title-text">
              {connecting ? t('voice.connecting', 'Connecting') : t('voice.connected', 'Voice Connected')}
            </span>
          </div>
          <div className="voice-controls-channel">
            {channel?.name ?? t('voice.voiceChannel')}{teamName ? ` / ${teamName}` : ''}
          </div>
        </div>
        <div className="voice-controls-right">
          {noiseSuppressionActive && (
            <div className="voice-ns-badge-wrap" ref={nsContainerRef}>
              <button
                type="button"
                className={`voice-btn voice-ns-badge ${nsPopoverOpen ? 'active' : ''}`}
                onClick={() => setNsPopoverOpen((v) => !v)}
                title={t('noiseSuppression.active', 'Noise suppression active')}
                aria-label={t('noiseSuppression.active', 'Noise suppression active')}
                aria-expanded={nsPopoverOpen}
                data-testid="voice-ns-badge"
              >
                <IconWaveSine size={18} stroke={1.75} />
              </button>
              {nsPopoverOpen && nsSnapshot && (
                <div className="voice-ns-popover" role="dialog">
                  <div className="voice-ns-popover-title">
                    {t('noiseSuppression.diagnostics', 'Diagnostics (local only)')}
                  </div>
                  <dl className="voice-ns-popover-stats">
                    <dt>{t('noiseSuppression.diagnosticsMedian', 'Median frame time')}</dt>
                    <dd data-testid="voice-ns-median">
                      {nsSnapshot.medianFrameMs.toFixed(2)} ms
                    </dd>
                    <dt>{t('noiseSuppression.diagnosticsP95', 'p95 frame time')}</dt>
                    <dd data-testid="voice-ns-p95">{nsSnapshot.p95FrameMs.toFixed(2)} ms</dd>
                    <dt>{t('noiseSuppression.diagnosticsProcessed', 'Frames processed')}</dt>
                    <dd data-testid="voice-ns-processed">{nsSnapshot.framesProcessed}</dd>
                    <dt>{t('noiseSuppression.diagnosticsDropped', 'Frames dropped')}</dt>
                    <dd data-testid="voice-ns-dropped">{nsSnapshot.framesDropped}</dd>
                  </dl>
                  <div className="voice-ns-popover-errors">
                    <div className="voice-ns-popover-errors-title">
                      {t('noiseSuppression.diagnosticsErrors', 'Recent errors')}
                    </div>
                    {nsSnapshot.errors.length === 0 ? (
                      <div
                        className="voice-ns-popover-errors-empty"
                        data-testid="voice-ns-no-errors"
                      >
                        {t('noiseSuppression.noErrors', 'No errors')}
                      </div>
                    ) : (
                      <ul className="voice-ns-popover-errors-list">
                        {nsSnapshot.errors.map((err, i) => (
                          <li key={`${err.timestamp}-${i}`}>{err.message}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
          <button
            className={`voice-btn webcam ${webcamSharing ? 'active' : ''}`}
            onClick={handleWebcam}
            title={webcamSharing ? t('voice.stopWebcam', 'Stop camera') : t('voice.startWebcam', 'Share camera')}
          >
            {webcamSharing ? <IconVideoOff size={18} stroke={1.75} /> : <IconVideo size={18} stroke={1.75} />}
          </button>
          <button
            className={`voice-btn screen-share ${screenSharing ? 'active' : ''}`}
            onClick={handleScreenShare}
            title={screenSharing ? t('voice.stopScreenShare', 'Stop sharing') : t('voice.startScreenShare', 'Share screen')}
          >
            <IconScreenShare size={18} stroke={1.75} />
          </button>
          <button
            className="voice-btn disconnect"
            onClick={leave}
            title={t('voice.leave')}
          >
            <IconPhoneOff size={20} stroke={1.75} />
          </button>
        </div>
      </div>
    </div>
  );
}
