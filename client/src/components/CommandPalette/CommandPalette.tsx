import { useEffect, useState, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import './CommandPalette.css';

export type CommandSection = 'NAVIGATE' | 'VOICE' | 'FEDERATION' | 'ENCRYPTION' | 'ACCOUNT';

export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  section: CommandSection;
  run: () => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
  commands: PaletteCommand[];
}

export default function CommandPalette({ open, onClose, commands }: Readonly<Props>) {
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    if (!query.trim()) return commands;
    const q = query.toLowerCase();
    return commands.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        c.section.toLowerCase().includes(q) ||
        (c.hint?.toLowerCase().includes(q) ?? false),
    );
  }, [query, commands]);

  // Group by section, preserving filtered order
  const grouped = useMemo(() => {
    const map = new Map<CommandSection, PaletteCommand[]>();
    for (const cmd of filtered) {
      const list = map.get(cmd.section) ?? [];
      list.push(cmd);
      map.set(cmd.section, list);
    }
    return Array.from(map.entries());
  }, [filtered]);

  // Reset on open
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIdx(0);
      // Focus the input on next tick
      const id = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(id);
    }
  }, [open]);

  // Keyboard nav
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const cmd = filtered[selectedIdx];
        if (cmd) {
          cmd.run();
          onClose();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, filtered, selectedIdx, onClose]);

  if (!open) return null;

  // Compute flat index for highlighting across sections
  let flatIdx = 0;

  const body = (
    <button
      type="button"
      className="command-palette-overlay"
      aria-label="Close command palette"
      onClick={onClose}
    >
      {/* Inner card stops click propagation so clicking inside doesn't dismiss */}
      <div
        role="dialog"
        aria-label="Command palette"
        className="command-palette"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="command-palette-prompt">
          <span className="command-palette-prompt-glyph" aria-hidden="true">
            &gt;
          </span>
          <input
            ref={inputRef}
            className="command-palette-input"
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIdx(0);
            }}
            placeholder="Type a command…"
            aria-label="Command query"
          />
          <span className="command-palette-hint">
            <kbd>ESC</kbd> close · <kbd>↑↓</kbd> move · <kbd>↵</kbd> run
          </span>
        </div>

        <div className="command-palette-list" role="listbox">
          {grouped.length === 0 && (
            <div className="command-palette-empty">No matching commands</div>
          )}
          {grouped.map(([section, cmds]) => (
            <div key={section} className="command-palette-section">
              <div className="command-palette-section-label">{section}</div>
              {cmds.map((cmd) => {
                const myIdx = flatIdx++;
                const selected = myIdx === selectedIdx;
                return (
                  <button
                    key={cmd.id}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={`command-palette-item ${selected ? 'selected' : ''}`}
                    onClick={() => {
                      cmd.run();
                      onClose();
                    }}
                    onMouseEnter={() => setSelectedIdx(myIdx)}
                  >
                    <span className="command-palette-item-label">{cmd.label}</span>
                    {cmd.hint && (
                      <span className="command-palette-item-hint">{cmd.hint}</span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </button>
  );

  return createPortal(body, document.body);
}
