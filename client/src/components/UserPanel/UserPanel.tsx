import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Settings, Microphone, MicrophoneMute, Headset, HeadsetWarning } from 'iconoir-react';
import { usePresenceStore } from '../../stores/presenceStore';
import { useTeamStore } from '../../stores/teamStore';
import { useAuthStore } from '../../stores/authStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { ws } from '../../services/websocket';
import { webrtcService } from '../../services/webrtc';
import { playMuteSound, playUnmuteSound } from '../../utils/sounds';
import PresenceIndicator from '../PresenceIndicator/PresenceIndicator';
import StatusPicker from '../StatusPicker/StatusPicker';
import type { PresenceStatus } from '../PresenceIndicator/PresenceIndicator';
import './UserPanel.css';

interface Props {
  username: string;
  displayName?: string;
  onSettingsClick?: () => void;
}

export default function UserPanel({
  username,
  displayName,
  onSettingsClick,
}: Props) {
  const { t } = useTranslation();
  const [showStatusPicker, setShowStatusPicker] = useState(false);
  const { myStatus, myCustomStatus, setMyStatus, setMyCustomStatus, updatePresence } = usePresenceStore();
  const { activeTeamId } = useTeamStore();
  const { teams } = useAuthStore();
  const { muted, deafened, toggleMute, toggleDeafen } = useVoiceStore();

  const currentUserId = (() => {
    if (!activeTeamId) return '';
    const entry = teams.get(activeTeamId);
    return (entry?.user as { id?: string } | null)?.id ?? '';
  })();
  const initials = (displayName ?? username)
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  useEffect(() => {
    if (!showStatusPicker) return;
    const close = () => setShowStatusPicker(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [showStatusPicker]);

  const handleStatusChange = useCallback(
    (status: PresenceStatus) => {
      setMyStatus(status);
      // Also update the presences store so MemberList reflects the change immediately
      if (activeTeamId && currentUserId) {
        updatePresence(activeTeamId, {
          user_id: currentUserId,
          status,
          custom_status: myCustomStatus,
          last_active: new Date().toISOString(),
        });
      }
      if (activeTeamId) {
        ws.updatePresence(activeTeamId, status, myCustomStatus || undefined);
      }
    },
    [activeTeamId, currentUserId, myCustomStatus, setMyStatus, updatePresence],
  );

  const handleCustomStatusChange = useCallback(
    (text: string) => {
      setMyCustomStatus(text);
      if (activeTeamId && currentUserId) {
        updatePresence(activeTeamId, {
          user_id: currentUserId,
          status: myStatus,
          custom_status: text,
          last_active: new Date().toISOString(),
        });
      }
      if (activeTeamId) {
        ws.updatePresence(activeTeamId, myStatus, text || undefined);
      }
    },
    [activeTeamId, currentUserId, myStatus, setMyCustomStatus, updatePresence],
  );

  const statusLabel = myCustomStatus || t(`presence.${myStatus}`);

  const handleMute = () => {
    if (muted) {
      playUnmuteSound();
    } else {
      playMuteSound();
    }
    webrtcService.toggleMute();
    toggleMute();
  };

  const handleDeafen = () => {
    if (deafened) {
      playUnmuteSound();
    } else {
      playMuteSound();
    }
    webrtcService.toggleDeafen();
    toggleDeafen();
  };

  return (
    <div className="user-panel">
      <div
        className="user-panel-avatar"
        onClick={(e) => {
          e.stopPropagation();
          setShowStatusPicker(!showStatusPicker);
        }}
      >
        {initials}
        <PresenceIndicator status={myStatus} size="medium" className="border-tertiary" />
      </div>
      <div
        className="user-panel-info"
        onClick={(e) => {
          e.stopPropagation();
          setShowStatusPicker(!showStatusPicker);
        }}
      >
        <div className="user-panel-name">{displayName ?? username}</div>
        <div className="user-panel-status-text">{statusLabel}</div>
      </div>
      <div className="user-panel-actions">
        <button
          className={`user-panel-btn ${muted ? 'user-panel-btn-active' : ''}`}
          onClick={handleMute}
          disabled={deafened}
          title={deafened ? t('voice.deafened', 'Deafened') : muted ? t('voice.unmute', 'Unmute') : t('voice.mute', 'Mute')}
        >
          {muted ? <MicrophoneMute width={20} height={20} strokeWidth={2} /> : <Microphone width={20} height={20} strokeWidth={2} />}
        </button>
        <button
          className={`user-panel-btn ${deafened ? 'user-panel-btn-active' : ''}`}
          onClick={handleDeafen}
          title={deafened ? t('voice.undeafen', 'Undeafen') : t('voice.deafen', 'Deafen')}
        >
          {deafened ? <HeadsetWarning width={20} height={20} strokeWidth={2} /> : <Headset width={20} height={20} strokeWidth={2} />}
        </button>
        <button
          className="user-panel-btn"
          onClick={onSettingsClick}
          title={t('settings.general')}
        >
          <Settings width={20} height={20} strokeWidth={2} />
        </button>
      </div>

      {showStatusPicker && (
        <StatusPicker
          currentStatus={myStatus}
          customStatus={myCustomStatus}
          onStatusChange={handleStatusChange}
          onCustomStatusChange={handleCustomStatusChange}
          onClose={() => setShowStatusPicker(false)}
        />
      )}
    </div>
  );
}
