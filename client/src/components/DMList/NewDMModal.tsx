import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Xmark, Check } from 'iconoir-react';
import { useTeamStore, type Member } from '../../stores/teamStore';
import { api } from '../../services/api';
import { useDMStore, type DMChannel } from '../../stores/dmStore';
import './NewDMModal.css';

interface Props {
  currentUserId: string;
  onClose: () => void;
  onDMCreated: (dm: DMChannel) => void;
}

export default function NewDMModal({ currentUserId, onClose, onDMCreated }: Props) {
  const { t } = useTranslation();
  const { activeTeamId, members } = useTeamStore();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Member[]>([]);
  const [creating, setCreating] = useState(false);

  const teamMembers = activeTeamId ? (members.get(activeTeamId) ?? []) : [];
  const availableMembers = teamMembers.filter((m) => m.userId !== currentUserId);

  const filtered = useMemo(() => {
    if (!search) return availableMembers;
    const q = search.toLowerCase();
    return availableMembers.filter(
      (m) =>
        m.username.toLowerCase().includes(q) ||
        m.displayName.toLowerCase().includes(q),
    );
  }, [availableMembers, search]);

  const toggleMember = (member: Member) => {
    setSelected((prev) => {
      if (prev.some((m) => m.userId === member.userId)) {
        return prev.filter((m) => m.userId !== member.userId);
      }
      return [...prev, member];
    });
  };

  const removeMember = (userId: string) => {
    setSelected((prev) => prev.filter((m) => m.userId !== userId));
  };

  const handleCreate = async () => {
    if (!activeTeamId || selected.length === 0) return;
    setCreating(true);
    try {
      const memberIds = selected.map((m) => m.userId);
      const dm = await api.createDM(activeTeamId, memberIds) as DMChannel;
      const { addDMChannel } = useDMStore.getState();
      addDMChannel(activeTeamId, dm);
      onDMCreated(dm);
      onClose();
    } catch {
      // API might not be available
    } finally {
      setCreating(false);
    }
  };

  // Close on escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div className="new-dm-overlay" onClick={onClose}>
      <div className="new-dm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="new-dm-header">
          <h3>{t('dm.newDM', 'New Message')}</h3>
          <button className="new-dm-close" onClick={onClose}><Xmark width={20} height={20} strokeWidth={2} /></button>
        </div>

        {selected.length > 0 && (
          <div className="new-dm-selected">
            {selected.map((m) => (
              <span key={m.userId} className="new-dm-chip">
                {m.displayName || m.username}
                <button className="new-dm-chip-remove" onClick={() => removeMember(m.userId)}>
                  <Xmark width={14} height={14} strokeWidth={2} />
                </button>
              </span>
            ))}
          </div>
        )}

        <input
          type="text"
          className="new-dm-search"
          placeholder={t('dm.searchMembers', 'Search members...')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
        />

        <div className="new-dm-member-list">
          {filtered.map((member) => {
            const isSelected = selected.some((m) => m.userId === member.userId);
            return (
              <div
                key={member.userId}
                className={`new-dm-member ${isSelected ? 'selected' : ''}`}
                onClick={() => toggleMember(member)}
              >
                <div className="new-dm-member-info">
                  <span className="new-dm-member-name">
                    {member.displayName || member.username}
                  </span>
                  <span className="new-dm-member-username">@{member.username}</span>
                </div>
                <div className={`new-dm-checkbox ${isSelected ? 'checked' : ''}`}>
                  {isSelected && <Check width={16} height={16} strokeWidth={2} />}
                </div>
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div className="new-dm-empty">No members found</div>
          )}
        </div>

        <div className="new-dm-footer">
          <button
            className="new-dm-create-btn"
            disabled={selected.length === 0 || creating}
            onClick={handleCreate}
          >
            {creating
              ? t('common.creating', 'Creating...')
              : selected.length > 1
                ? t('dm.groupDM', 'Group Message')
                : t('dm.startConversation', 'Start Conversation')}
          </button>
        </div>
      </div>
    </div>
  );
}
