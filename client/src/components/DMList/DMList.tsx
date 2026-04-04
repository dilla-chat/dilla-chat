import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Group } from 'iconoir-react';
import { useDMStore, type DMChannel } from '../../stores/dmStore';
import { useTeamStore } from '../../stores/teamStore';
import { api } from '../../services/api';
import { ws } from '../../services/websocket';
import { usernameColor, getInitials } from '../../utils/colors';

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
    <div className="flex flex-col flex-1 overflow-y-auto p-0">
      <div className="flex items-center justify-end px-lg pt-sm pb-xs">
        <button
          className="bg-transparent border-none text-interactive cursor-pointer text-[18px] px-xs py-0 leading-none rounded-sm transition-colors duration-150 hover:text-interactive-hover"
          onClick={onNewDM}
          title={t('dm.newDM', 'New Message')}
        >
          <Plus width={16} height={16} strokeWidth={2} />
        </button>
      </div>

      <div className="px-md pt-lg pb-sm">
        <input
          type="text"
          className="w-full py-1.5 px-2.5 rounded-sm border-none bg-surface-tertiary text-foreground text-base outline-none box-border transition-colors duration-150 focus:bg-surface placeholder:text-foreground-muted"
          placeholder={t('dm.searchMembers', 'Search members...')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      <div className="flex-1 overflow-y-auto py-xs">
        {filtered.length === 0 && (
          <div className="px-lg py-xl text-foreground-muted text-base text-center">
            {t('dm.noDMs', 'No direct messages yet')}
          </div>
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
              className={`dm-item-indicator clickable bg-transparent border-none w-[calc(100%-16px)] text-left font-[inherit] text-[inherit] text-inherit flex items-center py-1.5 px-sm mx-sm my-px rounded-sm gap-md hover:bg-surface-hover ${activeDMId === dm.id ? 'active bg-surface-active' : ''}`}
              data-testid="dm-item"
              data-active={activeDMId === dm.id}
              onClick={() => setActiveDM(dm.id)}
              type="button"
            >
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-white text-base font-medium shrink-0 relative"
                style={{ backgroundColor: usernameColor(avatarName) }}
              >
                {dm.is_group ? (
                  <span className="text-lg"><Group width={16} height={16} strokeWidth={2} /></span>
                ) : (
                  getInitials(avatarName)
                )}
              </div>
              <div className="flex-1 min-w-0 flex flex-col gap-px">
                <div className="flex items-center justify-between gap-sm">
                  <span className={`text-lg font-medium flex-1 truncate ${activeDMId === dm.id ? 'text-interactive-hover' : 'text-interactive'} group-hover:text-interactive-hover`}>
                    {displayName}
                  </span>
                  <span className="text-micro text-foreground-muted shrink-0 font-medium">
                    {formatTimestamp(timestamp)}
                  </span>
                </div>
                <div className="text-sm text-foreground-muted truncate">
                  {lastMsg || (
                    <span className="opacity-60">
                      {t('dm.noMessages', 'No messages yet. Say hello!')}
                    </span>
                  )}
                </div>
                {dm.is_group && (
                  <span className="text-xs text-foreground-muted">
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
