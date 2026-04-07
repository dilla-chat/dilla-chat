import { useTranslation } from 'react-i18next';
import { IconPhoneOff, IconScreenShare, IconVideo, IconVideoOff } from '@tabler/icons-react';
import { useVoiceConnection } from '../../hooks/useVoiceConnection';
import { useVoiceMediaState } from '../../stores/selectors';
import { useTeamStore, type Channel } from '../../stores/teamStore';
import ConnectionStatus from '../ConnectionStatus/ConnectionStatus';
import './VoiceControls.css';

export default function VoiceControls() {
  const { t } = useTranslation();
  const { currentChannelId, currentTeamId, connected, connecting, leave } = useVoiceConnection();
  const { screenSharing, webcamSharing } = useVoiceMediaState();

  const { channels, teams } = useTeamStore();

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
