import { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { SoundHigh, Plus, MicrophoneMute, HeadsetWarning, AppWindow } from 'iconoir-react';
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
  const { currentChannelId: voiceChannelId, connected: voiceConnected, peers: voicePeers, voiceOccupants, joinChannel: voiceJoin, muted: localMuted, deafened: localDeafened, screenSharing: localScreenSharing } = useVoiceStore();
  const { counts: unreadCounts } = useUnreadStore();
  const { teams, activeTeamId: authActiveTeamId } = useAuthStore();
  const currentUserId = (authActiveTeamId ? teams.get(authActiveTeamId)?.user?.id : '') ?? '';
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [editingChannel, setEditingChannel] = useState<Channel | null>(null);

  const rawChannels = activeTeamId ? channels.get(activeTeamId) : undefined;
  const teamChannels = Array.isArray(rawChannels) ? rawChannels : [];

  // Separate text and voice channels
  const textChannels = teamChannels.filter((ch) => ch.type !== 'voice');
  const voiceChannels = teamChannels.filter((ch) => ch.type === 'voice');

  const voiceLabel = t('channels.voiceChannels', 'Voice Channels');
  const textDefaultLabel = t('channels.textChannels', 'Text Channels');

  const groupByCategory = (chs: Channel[], defaultLabel: string, reservedLabel?: string) => {
    const grouped = chs.reduce<Record<string, Channel[]>>((acc, ch) => {
      let cat = ch.category || defaultLabel;
      if (reservedLabel && cat === reservedLabel) cat = defaultLabel;
      if (!acc[cat]) acc[cat] = [];
      acc[cat].push(ch);
      return acc;
    }, {});
    for (const cat of Object.keys(grouped)) {
      grouped[cat].sort((a, b) => a.position - b.position);
    }
    return grouped;
  };

  const textGrouped = groupByCategory(textChannels, textDefaultLabel, voiceLabel);
  const voiceGrouped: Record<string, Channel[]> = {};
  if (voiceChannels.length > 0) {
    voiceGrouped[voiceLabel] = [...voiceChannels].sort((a, b) => a.position - b.position);
  }

  const toggleCategory = (cat: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const handleContextMenu = useCallback((e: React.MouseEvent, channel: Channel) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, channel });
  }, []);

  useEffect(() => {
    const close = () => setContextMenu(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);

  const renderCategory = (cat: string, chs: Channel[]) => {
    const isCollapsed = collapsedCategories.has(cat);
    return (
      <div key={cat} className="channel-category">
        <div className="channel-category-header">
          <button className="channel-category-name micro" onClick={() => toggleCategory(cat)} type="button">
            <span className={`category-arrow ${isCollapsed ? 'collapsed' : ''}`}>▼</span>
            {cat}
          </button>
          {onCreateChannel && (
            <button
              type="button"
              className="channel-category-add"
              onClick={(e) => { e.stopPropagation(); onCreateChannel(cat); }}
              title={t('channels.create')}
            >
              <Plus width={16} height={16} strokeWidth={2} />
            </button>
          )}
        </div>
        {!isCollapsed &&
          chs.map((ch) => {
            const isVoice = ch.type === 'voice';
            const isVoiceConnected = isVoice && voiceConnected && voiceChannelId === ch.id;
            // Show rich peer data if connected, otherwise show occupants from server
            const voicePeerValues = Object.values(voicePeers);
            let voicePeerList: typeof voicePeerValues;
            if (isVoiceConnected) {
              // Merge local mute state into occupant data (which includes self)
              const occupants = voiceOccupants[ch.id] ?? [];
              voicePeerList = occupants.map(p =>
                p.user_id === currentUserId
                  ? { ...p, muted: localMuted, deafened: localDeafened, screen_sharing: localScreenSharing }
                  : p,
              );
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
                  <span className={`channel-icon ${isVoice && voicePeerList.length > 0 ? 'voice-active' : ''}`}>{isVoice ? <SoundHigh width={16} height={16} strokeWidth={2} /> : <span className="channel-tilde">~</span>}</span>
                  <span className={`channel-name truncate${hasUnread ? ' channel-name--unread' : ''}`}>{ch.name}</span>
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
                          {isMuted && <MicrophoneMute width={14} height={14} strokeWidth={2} className="voice-user-icon" />}
                          {isDeafened && <HeadsetWarning width={14} height={14} strokeWidth={2} className="voice-user-icon" />}
                          {isScreenSharing && <AppWindow width={14} height={14} strokeWidth={2} className="voice-user-icon screen-sharing" />}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
      </div>
    );
  };

  const textCategories = Object.keys(textGrouped).sort((a, b) => a.localeCompare(b));
  const voiceCategories = Object.keys(voiceGrouped).sort((a, b) => a.localeCompare(b));

  return (
    <div className="channel-list">
      {textCategories.map((cat) => renderCategory(cat, textGrouped[cat]))}
      {voiceCategories.map((cat) => renderCategory(cat, voiceGrouped[cat]))}

      {contextMenu && (
        <div
          className="channel-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
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
        </div>
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
