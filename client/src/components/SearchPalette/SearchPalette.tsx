import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './SearchPalette.css';

export interface SearchHit {
  id: string;
  channelId: string;
  channelName: string;
  author: string;
  authorColor?: string;
  timestamp: string;
  body: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Current channel name to scope by default; null = all kanals only */
  scopedChannelName: string | null;
  /** Provider for hits given the query + scope. Synchronous, in-memory. */
  search: (query: string, scope: 'channel' | 'all') => SearchHit[];
  onSelectHit: (hit: SearchHit) => void;
}

function highlight(body: string, query: string): React.ReactNode {
  if (!query.trim()) return body;
  const idx = body.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return body;
  return (
    <>
      {body.slice(0, idx)}
      <mark>{body.slice(idx, idx + query.length)}</mark>
      {body.slice(idx + query.length)}
    </>
  );
}

export default function SearchPalette({
  open,
  onClose,
  scopedChannelName,
  search,
  onSelectHit,
}: Readonly<Props>) {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<'channel' | 'all'>(
    scopedChannelName ? 'channel' : 'all',
  );
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const hits = useMemo(() => {
    if (!query.trim()) return [];
    return search(query, scope);
  }, [query, scope, search]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIdx(0);
      setScope(scopedChannelName ? 'channel' : 'all');
      const id = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(id);
    }
  }, [open, scopedChannelName]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, Math.max(hits.length - 1, 0)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const hit = hits[selectedIdx];
        if (hit) {
          onSelectHit(hit);
          onClose();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, hits, selectedIdx, onSelectHit, onClose]);

  if (!open) return null;

  const body = (
    <button
      type="button"
      className="search-palette-overlay"
      aria-label="Close search palette"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Search palette"
        className="search-palette"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="search-palette-prompt">
          <span className="search-palette-prompt-glyph" aria-hidden="true">/</span>
          <input
            ref={inputRef}
            className="search-palette-input"
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIdx(0);
            }}
            placeholder="Search messages…"
            aria-label="Search query"
          />
          {scopedChannelName && (
            <button
              type="button"
              className={`search-palette-scope ${scope === 'channel' ? 'active' : ''}`}
              onClick={() => setScope((s) => (s === 'channel' ? 'all' : 'channel'))}
            >
              {scope === 'channel' ? `✓ #${scopedChannelName}` : 'all kanals'}
            </button>
          )}
        </div>

        <div className="search-palette-results" role="listbox">
          {!query.trim() && (
            <div className="search-palette-tips">
              <div className="search-palette-tips-title">FILTERS</div>
              <div><code>from:</code> author name</div>
              <div><code>in:</code> channel name</div>
              <div><code>has:</code> link, image, code</div>
            </div>
          )}
          {query.trim() && hits.length === 0 && (
            <div className="search-palette-empty">No matches</div>
          )}
          {hits.map((hit, idx) => {
            const selected = idx === selectedIdx;
            return (
              <button
                key={hit.id}
                type="button"
                role="option"
                aria-selected={selected}
                className={`search-palette-hit ${selected ? 'selected' : ''}`}
                onClick={() => {
                  onSelectHit(hit);
                  onClose();
                }}
                onMouseEnter={() => setSelectedIdx(idx)}
              >
                <div className="search-palette-hit-meta">
                  <span className="search-palette-hit-channel">#{hit.channelName}</span>
                  <span className="search-palette-hit-divider">·</span>
                  <span
                    className="search-palette-hit-author"
                    style={hit.authorColor ? { color: hit.authorColor } : undefined}
                  >
                    {hit.author}
                  </span>
                  <span className="search-palette-hit-divider">·</span>
                  <span className="search-palette-hit-time">{hit.timestamp}</span>
                </div>
                <div className="search-palette-hit-body">
                  {highlight(hit.body, query)}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </button>
  );

  return createPortal(body, document.body);
}
