import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { IconPlus, IconUsers } from '@tabler/icons-react';
import { useDMStore, type DMChannel } from '../../stores/dmStore';
import { useTeamStore } from '../../stores/teamStore';
import { api } from '../../services/api';
import { ws } from '../../services/websocket';
import { usernameColor, getInitials } from '../../utils/colors';
import './DMList.css';

const EMPTY_DM_LIST: DMChannel[] = [];

interface Props {
  currentUserId: string;
  onNewDM: () => void;
}

function formatLastMessage(dm: DMChannel): string {
  if (!dm.last_message) return '';
  const content = dm.last_message.content;
  return content.length > 50 ? content.slice(0, 50) + '…' : content;
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  if (isToday) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString();
}

function getDMDisplayName(dm: DMChannel, currentUserId: string): string {
  if (dm.is_group) {
    return dm.members.map((m) => m.display_name || m.username).join(', ');
  }
  const other = dm.members.find((m) => m.user_id !== currentUserId);
  return other?.display_name || other?.username || 'Unknown';
}

export default function DMList({ currentUserId, onNewDM }: Readonly<Props>) {
  const { t } = useTranslation();
  const { activeTeamId } = useTeamStore();
  const activeDMId = useDMStore((state) => state.activeDMId);
  const setActiveDM = useDMStore((state) => state.setActiveDM);
  const setDMChannels = useDMStore((state) => state.setDMChannels);
  const channels = useDMStore((state) =>
    activeTeamId ? (state.dmChannels[activeTeamId] ?? EMPTY_DM_LIST) : EMPTY_DM_LIST
  );
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (!activeTeamId) return;
    const loadDMs = async () => {
      try {
        let channels: DMChannel[];
        if (ws.isConnected(activeTeamId)) {
          const data = await ws.request<{ dm_channels: DMChannel[] }>(activeTeamId, 'dms:list');
          channels = data.dm_channels ?? [];
        } else {
          channels = await api.getDMChannels(activeTeamId) as DMChannel[];
        }
        setDMChannels(activeTeamId, channels);
      } catch {
        // API/WS might not be available
      }
    };
    loadDMs();
  }, [activeTeamId, setDMChannels]);

  const sorted = useMemo(() => {
    return [...channels].sort((a, b) => {
      const aTime = a.last_message?.createdAt || a.created_at;
      const bTime = b.last_message?.createdAt || b.created_at;
      return new Date(bTime).getTime() - new Date(aTime).getTime();
    });
  }, [channels]);

  const filtered = useMemo(() => {
    if (!filter) return sorted;
    const q = filter.toLowerCase();
    return sorted.filter((dm) =>
      getDMDisplayName(dm, currentUserId).toLowerCase().includes(q),
    );
  }, [sorted, filter, currentUserId]);

  return (
    <div className="dm-list">
      <div className="dm-list-actions">
        <button className="dm-new-btn" onClick={onNewDM} title={t('dm.newDM', 'New Message')}>
          <IconPlus size={16} stroke={1.75} />
        </button>
      </div>

      <div className="dm-search">
        <input
          type="text"
          className="dm-search-input"
          placeholder={t('dm.searchMembers', 'Search members...')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      <div className="dm-items">
        {filtered.length === 0 && (
          <div className="dm-empty">{t('dm.noDMs', 'No direct messages yet')}</div>
        )}
        {filtered.map((dm) => {
          const displayName = getDMDisplayName(dm, currentUserId);
          const lastMsg = formatLastMessage(dm);
          const timestamp = dm.last_message?.createdAt || dm.created_at;
          const avatarName = dm.is_group
            ? dm.members[0]?.username || 'G'
            : (dm.members.find((m) => m.user_id !== currentUserId)?.username || 'U');

          return (
            <button
              key={dm.id}
              className={`dm-item clickable ${activeDMId === dm.id ? 'active' : ''}`}
              onClick={() => setActiveDM(dm.id)}
              type="button"
            >
              <div className="dm-item-avatar" style={{ backgroundColor: usernameColor(avatarName) }}>
                {dm.is_group ? (
                  <span className="dm-group-icon"><IconUsers size={16} stroke={1.75} /></span>
                ) : (
                  getInitials(avatarName)
                )}
              </div>
              <div className="dm-item-info">
                <div className="dm-item-header">
                  <span className="dm-item-name truncate">{displayName}</span>
                  <span className="dm-item-time">{formatTimestamp(timestamp)}</span>
                </div>
                <div className="dm-item-preview truncate">
                  {lastMsg || (
                    <span className="dm-item-no-msg">{t('dm.noMessages', 'No messages yet. Say hello!')}</span>
                  )}
                </div>
                {dm.is_group && (
                  <span className="dm-item-member-count">
                    {t('dm.members', '{{count}} members', { count: dm.members.length })}
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
