import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { IconSearch, IconHash, IconVolume, IconMessage } from '@tabler/icons-react';
import { useTeamStore, type Channel } from '../../stores/teamStore';
import { useDMStore } from '../../stores/dmStore';
import './QuickSwitcher.css';

export interface QuickSwitcherItem {
  id: string;
  name: string;
  type: 'text' | 'voice' | 'dm';
  teamName?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSelect: (item: QuickSwitcherItem) => void;
}

export default function QuickSwitcher({ open, onClose, onSelect }: Readonly<Props>) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { channels, teams } = useTeamStore();
  const { dmChannels } = useDMStore();

  // Build searchable items list
  const items = useMemo(() => {
    const result: QuickSwitcherItem[] = [];

    // Add channels from all teams
    for (const [teamId, teamChannels] of channels.entries()) {
      const teamName = teams.get(teamId)?.name ?? '';
      if (Array.isArray(teamChannels)) {
        for (const ch of teamChannels as Channel[]) {
          result.push({
            id: ch.id,
            name: ch.name,
            type: ch.type === 'voice' ? 'voice' : 'text',
            teamName,
          });
        }
      }
    }

    // Add DMs (dmChannels is Record<string, DMChannel[]>)
    for (const teamDMs of Object.values(dmChannels)) {
      for (const dm of teamDMs) {
        result.push({
          id: dm.id,
          name: dm.is_group
            ? ((dm as unknown as { name?: string }).name ?? dm.members.map((m) => m.username).join(', '))
            : dm.members.map((m) => m.display_name || m.username).join(', '),
          type: 'dm',
        });
      }
    }

    return result;
  }, [channels, teams, dmChannels]);

  // Fuzzy filter
  const filtered = useMemo(() => {
    if (!query.trim()) return items.slice(0, 10);
    const q = query.toLowerCase();
    return items.filter((item) => item.name.toLowerCase().includes(q)).slice(0, 10);
  }, [query, items]);

  // Reset on open
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: reset query/selection when modal opens
      setQuery('');
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: reset query/selection when modal opens
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Reset selection when query changes
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: reset selection cursor when filter changes
    setSelectedIndex(0);
  }, [query]);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' && filtered[selectedIndex]) {
        e.preventDefault();
        onSelect(filtered[selectedIndex]);
        onClose();
      } else if (e.key === 'Escape') {
        onClose();
      }
    },
    [filtered, selectedIndex, onSelect, onClose],
  );

  if (!open) return null;

  const icon = (type: string) => {
    if (type === 'voice') return <IconVolume size={14} stroke={1.75} />;
    if (type === 'dm') return <IconMessage size={14} stroke={1.75} />;
    return <IconHash size={14} stroke={1.75} />;
  };

  return createPortal(
    <div className="quick-switcher-overlay" onMouseDown={onClose}>
      <div
        className="quick-switcher"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="quick-switcher-input-row">
          <IconSearch size={16} stroke={1.75} className="quick-switcher-search-icon" />
          <input
            ref={inputRef}
            className="quick-switcher-input"
            placeholder="Jump to..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search channels"
          />
          <kbd className="quick-switcher-kbd">ESC</kbd>
        </div>
        <div className="quick-switcher-results" role="listbox" aria-label="Results">
          {filtered.length === 0 ? (
            <div className="quick-switcher-empty">No results</div>
          ) : (
            filtered.map((item, i) => (
              <button
                key={item.id}
                className={`quick-switcher-item${i === selectedIndex ? ' selected' : ''}`}
                onMouseEnter={() => setSelectedIndex(i)}
                onClick={() => {
                  onSelect(item);
                  onClose();
                }}
                type="button"
                role="option"
                aria-selected={i === selectedIndex}
              >
                <span className="quick-switcher-item-icon">{icon(item.type)}</span>
                <span className="quick-switcher-item-name">{item.name}</span>
                {item.teamName && (
                  <span className="quick-switcher-item-team">{item.teamName}</span>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
