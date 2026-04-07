import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { IconVolume, IconPlus, IconMicrophoneOff, IconHeadphonesOff, IconScreenShare, IconVideo } from '@tabler/icons-react';
import { useTeamStore, type Channel } from '../../stores/teamStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useUnreadStore } from '../../stores/unreadStore';
import { useAuthStore } from '../../stores/authStore';
import { api } from '../../services/api';
import EditChannel from '../EditChannel/EditChannel';
import './ChannelList.css';

interface ContextMenu {
  x: number;
  y: number;
  channel: Channel;
}

interface Props {
  onCreateChannel?: (category?: string) => void;
}

export default function ChannelList({ onCreateChannel }: Readonly<Props>) {
  const { t } = useTranslation();
  const { channels, activeTeamId, activeChannelId, setActiveChannel, removeChannel } = useTeamStore();
  const { currentChannelId: voiceChannelId, connected: voiceConnected, peers: voicePeers, voiceOccupants, joinChannel: voiceJoin, muted: localMuted, deafened: localDeafened, screenSharing: localScreenSharing, webcamSharing: localWebcamSharing } = useVoiceStore();
  const { counts: unreadCounts } = useUnreadStore();
  const authTeams = useAuthStore((s) => s.teams);
  const currentUserId = (activeTeamId ? authTeams.get(activeTeamId)?.user?.id : '') ?? '';
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [editingChannel, setEditingChannel] = useState<Channel | null>(null);

  const rawChannels = activeTeamId ? channels.get(activeTeamId) : undefined;
  const teamChannels = Array.isArray(rawChannels) ? rawChannels : [];

  // Build the three sections: unread, active voice, remaining
  const unreadChannels = teamChannels.filter((ch) => {
    const count = unreadCounts[ch.id] ?? 0;
    return ch.type !== 'voice' && count > 0;
  });

  const activeVoiceChannels = teamChannels.filter((ch) => {
    if (ch.type !== 'voice') return false;
    const occupants = voiceOccupants[ch.id] ?? [];
    const isConnected = voiceConnected && voiceChannelId === ch.id;
    const peerCount = isConnected ? Object.keys(voicePeers).length + 1 : occupants.length;
    return peerCount > 0;
  });

  const remainingChannels = teamChannels.filter((ch) => {
    const isUnread = ch.type !== 'voice' && (unreadCounts[ch.id] ?? 0) > 0;
    const isActiveVoice =
      ch.type === 'voice' && activeVoiceChannels.some((v) => v.id === ch.id);
    return !isUnread && !isActiveVoice;
  });

  const handleContextMenu = (e: React.MouseEvent, channel: Channel) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, channel });
  };

  useEffect(() => {
    const close = () => setContextMenu(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);

  const renderChannelItem = (ch: Channel) => {
    const isVoice = ch.type === 'voice';
    const isVoiceConnected = isVoice && voiceConnected && voiceChannelId === ch.id;
    // Show rich peer data if connected, otherwise show occupants from server
    const voicePeerValues = Object.values(voicePeers);
    let voicePeerList: typeof voicePeerValues;
    if (isVoiceConnected) {
      // WebRTC peers = remote users only. Add local user with store state.
      const localUsername =
        (activeTeamId ? authTeams.get(activeTeamId)?.user?.username : '') ?? 'You';
      const localEntry = {
        user_id: currentUserId,
        username: localUsername,
        muted: localMuted,
        deafened: localDeafened,
        screen_sharing: localScreenSharing,
        speaking: false,
        voiceLevel: 0,
      };
      voicePeerList = [localEntry, ...voicePeerValues.filter((p) => p.user_id !== currentUserId)];
    } else if (isVoice) {
      voicePeerList = voiceOccupants[ch.id] ?? [];
    } else {
      voicePeerList = [];
    }

    const unreadCount = unreadCounts[ch.id] ?? 0;
    const hasUnread = !isVoice && unreadCount > 0;

    return (
      <div key={ch.id}>
        <button
          className={`channel-item clickable ${activeChannelId === ch.id ? 'active' : ''}`}
          onClick={() => {
            setActiveChannel(ch.id);
            if (isVoice && !isVoiceConnected && activeTeamId) {
              voiceJoin(activeTeamId, ch.id);
            }
          }}
          onContextMenu={(e) => handleContextMenu(e, ch)}
          onKeyDown={(e) => {
            if (e.key === 'F10' && e.shiftKey) {
              e.preventDefault();
              handleContextMenu(e as unknown as React.MouseEvent, ch);
            }
          }}
        >
          <span
            className={`channel-icon ${isVoice && voicePeerList.length > 0 ? 'voice-active' : ''}`}
          >
            {isVoice ? (
              <IconVolume size={16} stroke={1.75} />
            ) : (
              <span className="channel-tilde">~</span>
            )}
          </span>
          <span className={`channel-name truncate${hasUnread ? ' channel-name--unread' : ''}`}>
            {ch.name}
          </span>
          {hasUnread && (
            <span className="channel-unread-badge" aria-label={`${unreadCount} unread messages`}>
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </button>
        {voicePeerList.length > 0 && (
          <div className="voice-channel-users">
            {voicePeerList.map((peer) => {
              const isLocal = peer.user_id === currentUserId;
              const isMuted = isLocal ? localMuted : peer.muted;
              const isDeafened = isLocal ? localDeafened : peer.deafened;
              const isScreenSharing = isLocal ? localScreenSharing : peer.screen_sharing;
              const isWebcamSharing = isLocal ? localWebcamSharing : false;
              return (
                <div
                  key={peer.user_id}
                  className={`voice-channel-user ${peer.speaking ? 'speaking' : ''}`}
                  style={{ '--voice-level': peer.voiceLevel ?? 0 } as React.CSSProperties}
                >
                  <span className="voice-user-avatar">
                    {peer.username.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="voice-user-name">{peer.username}</span>
                  {isMuted && (
                    <IconMicrophoneOff size={14} stroke={1.75} className="voice-user-icon" />
                  )}
                  {isDeafened && (
                    <IconHeadphonesOff size={14} stroke={1.75} className="voice-user-icon" />
                  )}
                  {isWebcamSharing && (
                    <IconVideo
                      size={14}
                      stroke={1.75}
                      className="voice-user-icon webcam-sharing"
                    />
                  )}
                  {isScreenSharing && (
                    <IconScreenShare
                      size={14}
                      stroke={1.75}
                      className="voice-user-icon screen-sharing"
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="channel-list">
      {unreadChannels.length > 0 && (
        <>
          <div className="channel-section-header unread-section">
            {t('channels.unread', 'UNREAD')}
          </div>
          {unreadChannels.map(renderChannelItem)}
          <div className="channel-section-divider" />
        </>
      )}

      {activeVoiceChannels.length > 0 && (
        <>
          <div className="channel-section-header">
            {t('channels.activeVoice', 'ACTIVE VOICE')}
          </div>
          {activeVoiceChannels.map(renderChannelItem)}
          <div className="channel-section-divider" />
        </>
      )}

      <div className="channel-section-header">
        {t('channels.channels', 'CHANNELS')}
        {onCreateChannel && (
          <button
            type="button"
            className="channel-category-add"
            onClick={() => onCreateChannel()}
            title={t('channels.create')}
          >
            <IconPlus size={16} stroke={1.75} />
          </button>
        )}
      </div>
      {remainingChannels.map(renderChannelItem)}

      {contextMenu && createPortal(
        <div
          className="channel-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="channel-context-item"
            onClick={() => {
              setEditingChannel(contextMenu.channel);
              setContextMenu(null);
            }}
            type="button"
          >
            {t('channels.edit', 'Edit Channel')}
          </button>
          <div className="channel-context-separator" />
          <button
            className="channel-context-item danger"
            onClick={async () => {
              if (!activeTeamId) return;
              const ch = contextMenu.channel;
              setContextMenu(null);
              try {
                await api.deleteChannel(activeTeamId, ch.id);
                removeChannel(activeTeamId, ch.id);
              } catch (err) {
                console.error('[ChannelList] Delete failed:', err);
              }
            }}
            type="button"
          >
            {t('channels.delete', 'Delete Channel')}
          </button>
        </div>,
        document.body,
      )}

      {editingChannel && (
        <EditChannel
          channel={editingChannel}
          onClose={() => setEditingChannel(null)}
        />
      )}
    </div>
  );
}
