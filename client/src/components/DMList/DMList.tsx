import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Group } from 'iconoir-react';
import { useDMStore, type DMChannel } from '../../stores/dmStore';
import { useTeamStore } from '../../stores/teamStore';
import { api } from '../../services/api';
import { ws } from '../../services/websocket';
import './DMList.css';

interface Props {
  currentUserId: string;
  onNewDM: () => void;
}

function getInitials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

function usernameColor(name: string): string {
  const colors = [
    '#f44336', '#e91e63', '#9c27b0', '#673ab7',
    '#3f51b5', '#2196f3', '#03a9f4', '#00bcd4',
    '#009688', '#4caf50', '#8bc34a', '#ff9800',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
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

export default function DMList({ currentUserId, onNewDM }: Props) {
  const { t } = useTranslation();
  const { activeTeamId } = useTeamStore();
  const { dmChannels, activeDMId, setActiveDM, setDMChannels } = useDMStore();
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

  const channels = activeTeamId ? (dmChannels[activeTeamId] ?? []) : [];

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
          <Plus width={16} height={16} strokeWidth={2} />
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
            <div
              key={dm.id}
              className={`dm-item ${activeDMId === dm.id ? 'active' : ''}`}
              onClick={() => setActiveDM(dm.id)}
            >
              <div className="dm-item-avatar" style={{ backgroundColor: usernameColor(avatarName) }}>
                {dm.is_group ? (
                  <span className="dm-group-icon"><Group width={16} height={16} strokeWidth={2} /></span>
                ) : (
                  getInitials(avatarName)
                )}
              </div>
              <div className="dm-item-info">
                <div className="dm-item-header">
                  <span className="dm-item-name">{displayName}</span>
                  <span className="dm-item-time">{formatTimestamp(timestamp)}</span>
                </div>
                <div className="dm-item-preview">
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
            </div>
          );
        })}
      </div>
    </div>
  );
}
