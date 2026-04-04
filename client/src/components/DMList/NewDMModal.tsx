import { useState, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Xmark, Check } from 'iconoir-react';
import { useTeamStore, type Member } from '../../stores/teamStore';
import { api } from '../../services/api';
import { useDMStore, type DMChannel } from '../../stores/dmStore';
import { useFocusTrap } from '../../hooks/useFocusTrap';

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
    <dialog
      className="fixed inset-0 border-none p-0 bg-transparent max-w-none max-h-none flex items-center justify-center z-[1000] bg-overlay-dark backdrop-blur-[4px]"
      open
      aria-labelledby="new-dm-title"
    >
      <button type="button" className="dialog-backdrop" onClick={onClose} aria-label="Close" />
      <div
        className="bg-glass-modal backdrop-blur-[var(--glass-blur-heavy)] border border-glass-border rounded-lg w-[440px] max-h-[600px] flex flex-col shadow-[0_8px_24px_var(--overlay-dark)] z-[1]"
        ref={modalRef}
      >
        <div className="flex items-center justify-between px-lg pt-lg pb-md">
          <h3 id="new-dm-title" className="m-0 text-[18px] text-foreground-primary">
            {t('dm.newDM', 'New Message')}
          </h3>
          <button
            className="bg-transparent border-none text-foreground-muted cursor-pointer text-[18px] p-xs hover:text-foreground-primary"
            onClick={onClose}
          >
            <Xmark width={20} height={20} strokeWidth={2} />
          </button>
        </div>

        {selected.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-lg pb-sm">
            {selected.map((m) => (
              <span
                key={m.userId}
                className="inline-flex items-center gap-xs bg-bg-accent text-white rounded-[12px] py-[3px] pr-2 pl-2.5 text-sm"
                data-testid="new-dm-chip"
              >
                {m.displayName || m.username}
                <button
                  className="bg-transparent border-none text-white-overlay-medium cursor-pointer text-micro px-0.5 py-0 leading-none hover:text-white"
                  onClick={() => removeMember(m.userId)}
                  data-testid="new-dm-chip-remove"
                >
                  <Xmark width={14} height={14} strokeWidth={2} />
                </button>
              </span>
            ))}
          </div>
        )}

        <input
          type="text"
          className="mx-lg mb-sm px-md py-sm rounded-sm border-none bg-surface-tertiary text-foreground-primary text-base outline-none placeholder:text-foreground-muted"
          placeholder={t('dm.searchMembers', 'Search members...')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
        />

        <div className="flex-1 overflow-y-auto px-sm max-h-[340px]">
          {filtered.map((member) => {
            const isSelected = selected.some((m) => m.userId === member.userId);
            return (
              <button
                key={member.userId}
                className={`bg-transparent border-none w-full text-left font-[inherit] text-[inherit] flex items-center justify-between px-md py-sm rounded-sm cursor-pointer text-foreground-secondary hover:bg-surface-hover ${isSelected ? 'bg-surface-selected' : ''}`}
                data-testid="new-dm-member"
                data-selected={isSelected}
                onClick={() => toggleMember(member)}
                type="button"
              >
                <div className="flex flex-col gap-px">
                  <span className="text-base font-medium text-foreground-primary">
                    {member.displayName || member.username}
                  </span>
                  <span className="text-xs text-foreground-muted">@{member.username}</span>
                </div>
                <div
                  className={`w-5 h-5 rounded-full border-2 flex items-center justify-center text-xs text-white shrink-0 ${isSelected ? 'bg-bg-accent border-bg-accent' : 'border-foreground-muted'}`}
                >
                  {isSelected && <Check width={16} height={16} strokeWidth={2} />}
                </div>
              </button>
            );
          })}
          {filtered.length === 0 && (
            <div className="p-5 text-center text-foreground-muted text-sm">No members found</div>
          )}
        </div>

        <div className="px-lg py-md border-t border-surface-tertiary">
          <button
            className="dm-create-btn w-full py-2.5 border border-white-overlay-light rounded-sm text-white text-base font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
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
