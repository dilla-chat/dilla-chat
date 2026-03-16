import { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { SoundHigh, Plus, MicrophoneMute, HeadsetWarning, AppWindow } from 'iconoir-react';
import { useTeamStore, type Channel } from '../../stores/teamStore';
import { useVoiceStore } from '../../stores/voiceStore';
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

export default function ChannelList({ onCreateChannel }: Props) {
  const { t } = useTranslation();
  const { channels, activeTeamId, activeChannelId, setActiveChannel, removeChannel } = useTeamStore();
  const { currentChannelId: voiceChannelId, connected: voiceConnected, peers: voicePeers, voiceOccupants, joinChannel: voiceJoin } = useVoiceStore();
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
          <span className="channel-category-name" onClick={() => toggleCategory(cat)}>
            <span className={`category-arrow ${isCollapsed ? 'collapsed' : ''}`}>▼</span>
            {cat}
          </span>
          {onCreateChannel && (
            <button
              className="channel-category-add"
              onClick={() => onCreateChannel(cat)}
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
            const voicePeerList = isVoiceConnected
              ? Object.values(voicePeers)
              : (isVoice ? (voiceOccupants[ch.id] ?? []) : []);

            return (
              <div key={ch.id}>
                <div
                  className={`channel-item ${activeChannelId === ch.id ? 'active' : ''}`}
                  onClick={() => {
                    setActiveChannel(ch.id);
                    if (isVoice && !isVoiceConnected && activeTeamId) {
                      voiceJoin(activeTeamId, ch.id);
                    }
                  }}
                  onContextMenu={(e) => handleContextMenu(e, ch)}
                >
                  <span className={`channel-icon ${isVoice && voicePeerList.length > 0 ? 'voice-active' : ''}`}>{isVoice ? <SoundHigh width={16} height={16} strokeWidth={2} /> : <span className="channel-tilde">~</span>}</span>
                  <span className="channel-name">{ch.name}</span>
                </div>
                {voicePeerList.length > 0 && (
                  <div className="voice-channel-users">
                    {voicePeerList.map((peer) => (
                      <div
                        key={peer.user_id}
                        className={`voice-channel-user ${peer.speaking ? 'speaking' : ''}`}
                        style={{ '--voice-level': peer.voiceLevel ?? 0 } as React.CSSProperties}
                      >
                        <span className="voice-user-avatar">
                          {peer.username.slice(0, 1).toUpperCase()}
                        </span>
                        <span className="voice-user-name">{peer.username}</span>
                        {peer.muted && <MicrophoneMute width={14} height={14} strokeWidth={2} className="voice-user-icon" />}
                        {peer.deafened && <HeadsetWarning width={14} height={14} strokeWidth={2} className="voice-user-icon" />}
                        {peer.screen_sharing && <AppWindow width={14} height={14} strokeWidth={2} className="voice-user-icon screen-sharing" />}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
      </div>
    );
  };

  const textCategories = Object.keys(textGrouped).sort();
  const voiceCategories = Object.keys(voiceGrouped).sort();

  return (
    <div className="channel-list">
      {textCategories.map((cat) => renderCategory(cat, textGrouped[cat]))}
      {voiceCategories.map((cat) => renderCategory(cat, voiceGrouped[cat]))}

      {contextMenu && (
        <div
          className="channel-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <div
            className="channel-context-item"
            onClick={() => {
              setEditingChannel(contextMenu.channel);
              setContextMenu(null);
            }}
          >
            {t('channels.edit', 'Edit Channel')}
          </div>
          <div
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
          >
            {t('channels.delete', 'Delete Channel')}
          </div>
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
