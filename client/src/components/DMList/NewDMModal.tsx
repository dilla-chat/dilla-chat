import { useState, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { IconX, IconCheck } from '@tabler/icons-react';
import { useTeamStore, type Member } from '../../stores/teamStore';
import { api } from '../../services/api';
import { useDMStore, type DMChannel } from '../../stores/dmStore';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import './NewDMModal.css';

interface Props {
  currentUserId: string;
  onClose: () => void;
  onDMCreated: (dm: DMChannel) => void;
}

export default function NewDMModal({ currentUserId, onClose, onDMCreated }: Readonly<Props>) {
  const { t } = useTranslation();
  const { activeTeamId, members } = useTeamStore();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Member[]>([]);
  const [creating, setCreating] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef, true, onClose);

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

  let createButtonLabel: string;
  if (creating) createButtonLabel = t('common.creating', 'Creating...');
  else if (selected.length > 1) createButtonLabel = t('dm.groupDM', 'Group Message');
  else createButtonLabel = t('dm.startConversation', 'Start Conversation');

  return (
    <dialog className="new-dm-overlay" open aria-labelledby="new-dm-title">
      <button type="button" className="dialog-backdrop" onClick={onClose} aria-label="Close" />
      <div className="new-dm-modal" ref={modalRef}>
        <div className="new-dm-header">
          <h3 id="new-dm-title">{t('dm.newDM', 'New Message')}</h3>
          <button className="new-dm-close" onClick={onClose}><IconX size={20} stroke={1.75} /></button>
        </div>

        {selected.length > 0 && (
          <div className="new-dm-selected">
            {selected.map((m) => (
              <span key={m.userId} className="new-dm-chip">
                {m.displayName || m.username}
                <button className="new-dm-chip-remove" onClick={() => removeMember(m.userId)}>
                  <IconX size={14} stroke={1.75} />
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
              <button
                key={member.userId}
                className={`new-dm-member ${isSelected ? 'selected' : ''}`}
                onClick={() => toggleMember(member)}
                type="button"
              >
                <div className="new-dm-member-info">
                  <span className="new-dm-member-name">
                    {member.displayName || member.username}
                  </span>
                  <span className="new-dm-member-username">@{member.username}</span>
                </div>
                <div className={`new-dm-checkbox ${isSelected ? 'checked' : ''}`}>
                  {isSelected && <IconCheck size={16} stroke={1.75} />}
                </div>
              </button>
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
            {createButtonLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
