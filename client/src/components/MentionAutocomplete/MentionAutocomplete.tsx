import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import './MentionAutocomplete.css';

interface MentionUser {
  id: string;
  username: string;
  avatarColor?: string;
}

interface Props {
  users: MentionUser[];
  query: string;
  position: { top: number; left: number };
  onSelect: (user: MentionUser) => void;
  onClose: () => void;
}

export default function MentionAutocomplete({ users, query, position, onSelect, onClose }: Readonly<Props>) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  const filtered = users
    .filter(u => u.username.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 8);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: reset cursor when filter query changes
    setSelectedIndex(0);
  }, [query]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Tab' || e.key === 'Enter') {
      if (filtered[selectedIndex]) {
        e.preventDefault();
        onSelect(filtered[selectedIndex]);
      }
    } else if (e.key === 'Escape') {
      onClose();
    }
  }, [filtered, selectedIndex, onSelect, onClose]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  if (filtered.length === 0) return null;

  return createPortal(
    <div ref={ref} className="mention-autocomplete" style={{ bottom: `calc(100vh - ${position.top}px)`, left: position.left }}>
      {filtered.map((user, i) => (
        <button
          key={user.id}
          className={`mention-autocomplete-item ${i === selectedIndex ? 'selected' : ''}`}
          onMouseEnter={() => setSelectedIndex(i)}
          onClick={() => onSelect(user)}
          type="button"
        >
          <div
            className="mention-autocomplete-avatar"
            style={{ background: user.avatarColor ?? 'var(--brand-500)' }}
          >
            {user.username.slice(0, 1).toUpperCase()}
          </div>
          <span className="mention-autocomplete-name">{user.username}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
