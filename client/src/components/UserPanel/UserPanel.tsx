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
    <div className="flex items-center px-[var(--spacing-md)] h-[var(--user-panel-height)] gap-2">
      <button
        className="border-none p-0 size-8 rounded-full bg-accent text-white flex items-center justify-center text-base font-medium font-[inherit] shrink-0 relative cursor-pointer transition-shadow duration-150 ease-out hover:shadow-[0_0_0_4px_var(--white-overlay-subtle)]"
        onClick={(e) => {
          e.stopPropagation();
          setShowStatusPicker(!showStatusPicker);
        }}
        type="button"
        data-testid="user-panel-avatar"
      >
        {initials}
        <PresenceIndicator status={myStatus} size="medium" className="border-tertiary" />
      </button>
      <button
        className="bg-none border-none text-left font-[inherit] text-[inherit] text-inherit flex-1 min-w-0 cursor-pointer py-1"
        onClick={(e) => {
          e.stopPropagation();
          setShowStatusPicker(!showStatusPicker);
        }}
        type="button"
        data-testid="user-panel-info"
      >
        <div className="text-lg font-semibold leading-[1.375] text-heading truncate">{displayName ?? username}</div>
        <div className="text-xs font-normal leading-[1.4] text-foreground-muted truncate">{statusLabel}</div>
      </button>
      <div className="flex gap-2">
        <button
          className={`clickable bg-none border-none p-0 text-xl size-8 flex items-center justify-center ${muted ? 'text-[var(--text-danger)] hover:text-[var(--text-danger)] hover:bg-surface-hover' : 'text-interactive hover:text-interactive-hover'} disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-none disabled:hover:text-[var(--text-danger)]`}
          onClick={handleMute}
          disabled={deafened}
          title={muteTitle}
        >
          {muted ? <MicrophoneMute width={20} height={20} strokeWidth={2} /> : <Microphone width={20} height={20} strokeWidth={2} />}
        </button>
        <button
          className={`clickable bg-none border-none p-0 text-xl size-8 flex items-center justify-center ${deafened ? 'text-[var(--text-danger)] hover:text-[var(--text-danger)] hover:bg-surface-hover' : 'text-interactive hover:text-interactive-hover'}`}
          onClick={handleDeafen}
          title={deafened ? t('voice.undeafen', 'Undeafen') : t('voice.deafen', 'Deafen')}
        >
          {deafened ? <HeadsetWarning width={20} height={20} strokeWidth={2} /> : <Headset width={20} height={20} strokeWidth={2} />}
        </button>
        <button
          className="clickable bg-none border-none text-interactive p-0 text-xl size-8 flex items-center justify-center hover:text-interactive-hover"
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
