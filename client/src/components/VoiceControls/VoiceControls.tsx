import { useTranslation } from 'react-i18next';
import { PhoneXmark, AppWindow, VideoCamera, VideoCameraOff } from 'iconoir-react';
import { useVoiceConnection } from '../../hooks/useVoiceConnection';
import { useVoiceMediaState } from '../../stores/selectors';
import { useTeamStore, type Channel } from '../../stores/teamStore';
import ConnectionStatus from '../ConnectionStatus/ConnectionStatus';

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
    <div className="pt-2.5 px-3 pb-1.5 overflow-visible animate-voice-slide-in" data-testid="voice-controls">
      <div className="flex items-center gap-sm">
        <div className="flex flex-col gap-px min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-status-online text-sm font-semibold leading-[18px]">
            <ConnectionStatus />
            <span className="text-status-online">
              {connecting ? t('voice.connecting', 'Connecting') : t('voice.connected', 'Voice Connected')}
            </span>
          </div>
          <div className="text-xs text-foreground-muted font-normal truncate">
            {channel?.name ?? t('voice.voiceChannel')}{teamName ? ` / ${teamName}` : ''}
          </div>
        </div>
        <div className="flex items-center gap-sm shrink-0 ml-auto">
          <button
            className={`bg-transparent border-none text-interactive cursor-pointer p-0 rounded-sm w-8 h-8 flex items-center justify-center transition-[color,background-color] duration-150 ease-linear hover:text-interactive-hover hover:bg-surface-hover ${webcamSharing ? 'active text-foreground-danger bg-danger-a15 hover:bg-danger-a25' : ''}`}
            onClick={handleWebcam}
            title={webcamSharing ? t('voice.stopWebcam', 'Stop camera') : t('voice.startWebcam', 'Share camera')}
          >
            {webcamSharing ? <VideoCameraOff width={18} height={18} strokeWidth={2} /> : <VideoCamera width={18} height={18} strokeWidth={2} />}
          </button>
          <button
            className={`bg-transparent border-none text-interactive cursor-pointer p-0 rounded-sm w-8 h-8 flex items-center justify-center transition-[color,background-color] duration-150 ease-linear hover:text-interactive-hover hover:bg-surface-hover ${screenSharing ? 'active text-foreground-danger bg-danger-a15 hover:bg-danger-a25' : ''}`}
            onClick={handleScreenShare}
            title={screenSharing ? t('voice.stopScreenShare', 'Stop sharing') : t('voice.startScreenShare', 'Share screen')}
          >
            <AppWindow width={18} height={18} strokeWidth={2} />
          </button>
          <button
            className="bg-transparent border-none text-foreground-danger cursor-pointer p-0 rounded-sm w-8 h-8 flex items-center justify-center transition-[color,background-color] duration-150 ease-linear hover:bg-surface-hover"
            onClick={leave}
            title={t('voice.leave')}
          >
            <PhoneXmark width={20} height={20} strokeWidth={2} />
          </button>
        </div>
      </div>
    </div>
  );
}
