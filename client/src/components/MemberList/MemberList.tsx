import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useTeamStore, type Member } from '../../stores/teamStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { useAuthStore } from '../../stores/authStore';
import { useDMStore } from '../../stores/dmStore';
import { api } from '../../services/api';
import UserProfile from '../UserProfile/UserProfile';
import './MemberList.css';

interface ProfilePopup {
  member: Member;
  x: number;
  y: number;
}

const STATUS_PRIORITY: Record<string, number> = {
  online: 0,
  idle: 1,
  dnd: 2,
  offline: 3,
};

export default function MemberList() {
  const { t } = useTranslation();
  const { members, activeTeamId } = useTeamStore();
  const presences = usePresenceStore((s) => s.presences);
  const { teams } = useAuthStore();
  const { setActiveDM } = useDMStore();
  const [popup, setPopup] = useState<ProfilePopup | null>(null);

  const teamMembers = useMemo(() => activeTeamId ? (members.get(activeTeamId) ?? []) : [], [activeTeamId, members]);
  const teamPresences = useMemo(() => activeTeamId ? (presences[activeTeamId] ?? {}) : {}, [activeTeamId, presences]);

  const currentTeamEntry = activeTeamId ? teams.get(activeTeamId) : null;
  const currentUserId = currentTeamEntry?.user?.id ?? '';

  const getStatus = useCallback(
    (userId: string) => teamPresences[userId]?.status ?? 'offline',
    [teamPresences],
  );

  // Group and sort members by presence status
  const { onlineGroup, offlineGroup } = useMemo(() => {
    const online: Member[] = [];
    const offline: Member[] = [];

    for (const member of teamMembers) {
      const status = getStatus(member.userId);
      if (status === 'offline') {
        offline.push(member);
      } else {
        online.push(member);
      }
    }

    // Sort online by status priority, then alphabetically
    online.sort((a, b) => {
      const aPri = STATUS_PRIORITY[getStatus(a.userId)] ?? 3;
      const bPri = STATUS_PRIORITY[getStatus(b.userId)] ?? 3;
      if (aPri !== bPri) return aPri - bPri;
      return (a.displayName || a.username).localeCompare(b.displayName || b.username);
    });

    offline.sort((a, b) =>
      (a.displayName || a.username).localeCompare(b.displayName || b.username),
    );

    return { onlineGroup: online, offlineGroup: offline };
  }, [teamMembers, getStatus]);

  const handleMemberClick = useCallback((e: React.MouseEvent, member: Member) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPopup({ member, x: rect.left - 310, y: rect.top });
  }, []);

  const handleSendMessage = useCallback(
    async (member: Member) => {
      if (!activeTeamId || member.userId === currentUserId) return;
      try {
        const dm = await api.createDM(activeTeamId, [member.userId]) as { id: string };
        setActiveDM(dm.id);
        setPopup(null);
      } catch {
        // ignore
      }
    },
    [activeTeamId, currentUserId, setActiveDM],
  );

  useEffect(() => {
    if (!popup) return;
    const close = () => setPopup(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [popup]);

  const getInitials = (m: Member) =>
    (m.displayName || m.username || '?')
      .split(' ')
      .map((w) => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();

  const renderMember = (member: Member) => {
    const status = getStatus(member.userId);
    const isOffline = status === 'offline';
    const customStatus = teamPresences[member.userId]?.custom_status;

    return (
      <button
        key={member.id}
        className={`member-item ${isOffline ? 'offline' : ''}`}
        onClick={(e) => handleMemberClick(e, member)}
        type="button"
      >
        <div className="member-avatar" data-status={status}>
          {getInitials(member)}
        </div>
        <div className="member-info">
          <div className="member-display-name truncate">
            {member.nickname || member.displayName || member.username}
          </div>
          {customStatus && (
            <div className="member-custom-status truncate caption">{customStatus}</div>
          )}
        </div>
      </button>
    );
  };

  return (
    <div className="member-list">
      {onlineGroup.length > 0 && (
        <div className="member-role-group">
          <div className="member-role-header micro">
            {t('presence.onlineCount', { count: onlineGroup.length })}
          </div>
          {onlineGroup.map(renderMember)}
        </div>
      )}

      {offlineGroup.length > 0 && (
        <div className="member-role-group">
          <div className="member-role-header micro">
            {t('presence.offlineCount', { count: offlineGroup.length })}
          </div>
          {offlineGroup.map(renderMember)}
        </div>
      )}

      {popup && (
        <UserProfile
          member={popup.member}
          presence={teamPresences[popup.member.userId]}
          x={popup.x}
          y={popup.y}
          onSendMessage={
            popup.member.userId === currentUserId
              ? undefined
              : () => handleSendMessage(popup.member)
          }
        />
      )}
    </div>
  );
}
