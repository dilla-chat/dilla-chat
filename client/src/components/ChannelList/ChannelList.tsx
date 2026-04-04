import { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { SoundHigh, Plus, MicrophoneMute, HeadsetWarning, AppWindow } from 'iconoir-react';
import { useTeamStore, type Channel } from '../../stores/teamStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useUnreadStore } from '../../stores/unreadStore';
import { api } from '../../services/api';
import EditChannel from '../EditChannel/EditChannel';

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
  const { currentChannelId: voiceChannelId, connected: voiceConnected, peers: voicePeers, voiceOccupants, joinChannel: voiceJoin } = useVoiceStore();
  const { counts: unreadCounts } = useUnreadStore();
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
      <div key={cat} className="pt-lg">
        <div className="flex items-center justify-between px-sm h-7 cursor-pointer select-none">
          <button className="text-micro font-medium uppercase tracking-wide text-foreground-muted flex items-center gap-xs flex-1 overflow-hidden bg-transparent border-none p-0 rounded-none transition-colors duration-150 hover:text-interactive-hover" onClick={() => toggleCategory(cat)} type="button">
            <span className={`text-micro transition-transform duration-150${isCollapsed ? ' -rotate-90' : ''}`}>▼</span>
            {cat}
          </button>
          {onCreateChannel && (
            <button
              className="bg-transparent border-none text-interactive cursor-pointer text-lg px-xs leading-none rounded-sm transition-colors duration-150 hover:text-interactive-hover"
              onClick={() => onCreateChannel(cat)}
              title={t('channels.create')}
              data-testid="channel-category-add"
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
            if (isVoiceConnected) voicePeerList = voicePeerValues;
            else if (isVoice) voicePeerList = voiceOccupants[ch.id] ?? [];
            else voicePeerList = [];

            const unreadCount = unreadCounts[ch.id] ?? 0;
            const hasUnread = !isVoice && unreadCount > 0;

            return (
              <div key={ch.id}>
                <button
                  className={`channel-item flex items-center py-1.5 px-sm mx-sm my-px border-none rounded-md bg-transparent font-inherit text-left w-[calc(100%-16px)] text-interactive text-lg font-medium gap-1.5 relative before:hidden clickable${activeChannelId === ch.id ? ' active bg-surface-active text-interactive-active' : ''} hover:bg-surface-hover hover:text-interactive-hover`}
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
                  <span className={`text-xl w-5 text-center shrink-0 text-channel-icon transition-colors duration-150${isVoice && voicePeerList.length > 0 ? ' !text-status-online' : ''}${activeChannelId === ch.id ? ' !text-interactive-active' : ''}`}>{isVoice ? <SoundHigh width={16} height={16} strokeWidth={2} /> : <span className="channel-tilde">~</span>}</span>
                  <span className={`flex-1 truncate${hasUnread ? ' channel-name--unread font-semibold text-interactive-hover' : ''}`}>{ch.name}</span>
                  {hasUnread && (
                    <span className="min-w-4 h-4 px-xs rounded-full bg-brand text-white text-micro font-semibold flex items-center justify-center ml-auto shrink-0" aria-label={`${unreadCount} unread messages`}>
                      {unreadCount > 99 ? '99+' : unreadCount}
                    </span>
                  )}
                  <span className="hidden gap-0.5 group-hover/item:flex">
                  </span>
                </button>
                {voicePeerList.length > 0 && (
                  <div className="py-0.5 px-sm pl-[42px] flex flex-col gap-px">
                    {voicePeerList.map((peer) => (
                      <div
                        key={peer.user_id}
                        className={`flex items-center gap-1.5 text-base text-interactive px-xs rounded-sm transition-colors duration-150 py-0.5 hover:bg-surface-hover${peer.speaking ? ' text-status-online' : ''}`}
                        style={{ '--voice-level': peer.voiceLevel ?? 0 } as React.CSSProperties}
                      >
                        <span className={`w-5 h-5 rounded-full bg-bg-accent text-white flex items-center justify-center text-micro font-semibold shrink-0 shadow-[0_0_0_1.5px_var(--white-overlay-light)] transition-shadow duration-150${peer.speaking ? ' !shadow-[0_0_0_1.5px_var(--status-online)]' : ''}`}>
                          {peer.username.slice(0, 1).toUpperCase()}
                        </span>
                        <span className="truncate flex-1">{peer.username}</span>
                        {peer.muted && <MicrophoneMute width={14} height={14} strokeWidth={2} className="shrink-0 text-foreground-muted opacity-70" />}
                        {peer.deafened && <HeadsetWarning width={14} height={14} strokeWidth={2} className="shrink-0 text-foreground-muted opacity-70" />}
                        {peer.screen_sharing && <AppWindow width={14} height={14} strokeWidth={2} className="shrink-0 text-status-online opacity-100" />}
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

  const textCategories = Object.keys(textGrouped).sort((a, b) => a.localeCompare(b));
  const voiceCategories = Object.keys(voiceGrouped).sort((a, b) => a.localeCompare(b));

  return (
    <div className="flex flex-col flex-1 overflow-y-auto p-0">
      {textCategories.map((cat) => renderCategory(cat, textGrouped[cat]))}
      {voiceCategories.map((cat) => renderCategory(cat, voiceGrouped[cat]))}

      {contextMenu && (
        <div
          className="channel-context-menu fixed bg-glass-floating backdrop-blur-glass-heavy border border-glass-border shadow-glass-elevated rounded-lg py-1.5 px-sm min-w-[188px] z-[1000]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            className="bg-transparent border-none w-full text-left flex items-center py-1.5 px-sm rounded-sm cursor-pointer text-interactive text-base font-medium font-inherit transition-colors duration-150 hover:bg-brand hover:text-white"
            onClick={() => {
              setEditingChannel(contextMenu.channel);
              setContextMenu(null);
            }}
            type="button"
          >
            {t('channels.edit', 'Edit Channel')}
          </button>
          <button
            className="bg-transparent border-none w-full text-left flex items-center py-1.5 px-sm rounded-sm cursor-pointer text-foreground-danger text-base font-medium font-inherit transition-colors duration-150 hover:bg-foreground-danger hover:text-white"
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
