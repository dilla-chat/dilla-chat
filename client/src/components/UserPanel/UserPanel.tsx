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
}: Readonly<Props>) {
  const { t } = useTranslation();
  const [showStatusPicker, setShowStatusPicker] = useState(false);
  const { myStatus, myCustomStatus, setMyStatus, setMyCustomStatus, updatePresence } = usePresenceStore();
  const { activeTeamId } = useTeamStore();
  const { teams } = useAuthStore();
  const { muted, deafened, setMuted, setDeafened } = useVoiceStore();

  const currentUserId = (() => {
    if (!activeTeamId) return '';
    const entry = teams.get(activeTeamId);
    return entry?.user?.id ?? '';
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

  const handleMute = async () => {
    const newMuted = await webrtcService.toggleMute();
    setMuted(newMuted);
    if (newMuted) {
      playMuteSound();
    } else {
      playUnmuteSound();
    }
  };

  const handleDeafen = async () => {
    const newDeafened = await webrtcService.toggleDeafen();
    setDeafened(newDeafened);
    if (newDeafened) {
      playMuteSound();
    } else {
      playUnmuteSound();
    }
  };

  let muteTitle = t('voice.mute', 'Mute');
  if (deafened) muteTitle = t('voice.deafened', 'Deafened');
  else if (muted) muteTitle = t('voice.unmute', 'Unmute');

  return (
    <div className="user-panel">
      <button
        className="user-panel-avatar"
        onClick={(e) => {
          e.stopPropagation();
          setShowStatusPicker(!showStatusPicker);
        }}
        type="button"
      >
        {initials}
        <PresenceIndicator status={myStatus} size="medium" className="border-tertiary" />
      </button>
      <button
        className="user-panel-info"
        onClick={(e) => {
          e.stopPropagation();
          setShowStatusPicker(!showStatusPicker);
        }}
        type="button"
      >
        <div className="user-panel-name">{displayName ?? username}</div>
        <div className="user-panel-status-text">{statusLabel}</div>
      </button>
      <div className="user-panel-actions">
        <button
          className={`user-panel-btn ${muted ? 'user-panel-btn-active' : ''}`}
          onClick={handleMute}
          disabled={deafened}
          title={muteTitle}
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
