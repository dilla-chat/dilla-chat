import { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Search, Xmark } from 'iconoir-react';
import { useMessageStore, type Message } from '../../stores/messageStore';

interface Props {
  onJumpToMessage?: (channelId: string, messageId: string) => void;
}

interface SearchResult {
  message: Message;
  matchStart: number;
  matchEnd: number;
}

export default function SearchBar({ onJumpToMessage }: Readonly<Props>) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const { messages } = useMessageStore();

  const showDropdown = focused && query.trim().length > 0;

  const doSearch = useCallback(
    (searchQuery: string) => {
      if (!searchQuery.trim()) {
        setResults([]);
        return;
      }

      const lower = searchQuery.toLowerCase();
      const found: SearchResult[] = [];

      for (const [, channelMessages] of messages) {
        for (const msg of channelMessages) {
          if (msg.deleted) continue;
          const idx = msg.content.toLowerCase().indexOf(lower);
          if (idx !== -1) {
            found.push({
              message: msg,
              matchStart: idx,
              matchEnd: idx + searchQuery.length,
            });
          }
        }
      }

      found.sort(
        (a, b) =>
          new Date(b.message.createdAt).getTime() -
          new Date(a.message.createdAt).getTime(),
      );

      setResults(found.slice(0, 50));
    },
    [messages],
  );

  const handleChange = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(value), 300);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setQuery('');
      setResults([]);
      inputRef.current?.blur();
    }
  };

  const handleResultClick = (result: SearchResult) => {
    onJumpToMessage?.(result.message.channelId, result.message.id);
    setQuery('');
    setResults([]);
    inputRef.current?.blur();
  };

  const handleClear = () => {
    setQuery('');
    setResults([]);
    inputRef.current?.focus();
  };

  const dropdownRef = useRef<HTMLDivElement>(null);

  // Collapse search bar and close dropdown on click outside
  useEffect(() => {
    if (!focused) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      const inContainer = containerRef.current?.contains(target);
      const inDropdown = dropdownRef.current?.contains(target);
      if (!inContainer && !inDropdown) {
        setFocused(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [focused]);

  return (
    <div className="relative" ref={containerRef}>
      <div
        className={`flex items-center bg-input border border-transparent rounded-lg px-sm h-7 w-[200px] max-md:w-[140px] transition-all duration-200 ease-out box-border ${focused ? 'w-[300px] max-md:w-[200px] border-brand shadow-[0_0_0_2px_var(--brand-alpha-12)]' : ''}`}
        data-focused={focused || undefined}
      >
        <Search className="text-foreground-muted shrink-0" width={16} height={16} strokeWidth={2} />
        <input
          ref={inputRef}
          type="text"
          className="flex-1 bg-transparent border-none text-foreground-primary text-sm font-[inherit] outline-none px-1.5 min-w-0"
          placeholder={t('search.placeholder', 'Search messages...')}
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => setFocused(true)}
        />
        {query && (
          <button
            className="bg-transparent border-none text-interactive cursor-pointer p-0 w-5 h-5 flex items-center justify-center rounded-sm shrink-0 transition-colors duration-[120ms] ease-out hover:text-interactive-hover"
            onClick={handleClear}
          >
            <Xmark width={14} height={14} strokeWidth={2} />
          </button>
        )}
      </div>

      {showDropdown && createPortal(
        <div
          ref={dropdownRef}
          className="fixed w-[420px] max-md:w-[calc(100vw-16px)] max-md:max-w-[420px] md:max-lg:w-[min(420px,calc(100vw-340px))] max-h-[60vh] overflow-y-auto bg-glass-floating backdrop-blur-glass-heavy border border-glass-border shadow-glass-elevated rounded-lg z-dropdown p-sm"
          style={{
            top: (containerRef.current?.getBoundingClientRect().bottom ?? 0) + 6,
            right: window.innerWidth - (containerRef.current?.getBoundingClientRect().right ?? 0),
          }}
        >
          {results.length === 0 ? (
            <div className="text-center py-xl px-lg text-foreground-muted text-base">
              {t('search.noResults', 'No results found')}
            </div>
          ) : (
            <>
              <div className="px-sm py-xs text-micro">
                {t('search.results', '{{count}} results', { count: results.length })}
              </div>
              {results.map((result) => (
                <button
                  key={result.message.id}
                  className="bg-transparent border-none w-full text-left font-[inherit] text-[inherit] text-[length:inherit] py-2.5 px-3 rounded-sm cursor-pointer mb-0.5 transition-colors duration-150 ease-out hover:bg-surface-hover"
                  onClick={() => handleResultClick(result)}
                  type="button"
                  data-testid="search-result"
                >
                  <div className="flex items-baseline gap-sm mb-0.5">
                    <span className="text-base font-medium text-heading">
                      {result.message.username}
                    </span>
                    <span className="text-micro text-foreground-muted font-medium">
                      {new Date(result.message.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <div className="text-sm text-foreground overflow-hidden text-ellipsis line-clamp-2 leading-[1.375]">
                    {result.message.content.substring(0, result.matchStart)}
                    <mark className="bg-accent-a25 text-heading rounded-[2px] px-0.5 font-medium" data-testid="search-highlight">
                      {result.message.content.substring(
                        result.matchStart,
                        result.matchEnd,
                      )}
                    </mark>
                    {result.message.content.substring(result.matchEnd)}
                  </div>
                </button>
              ))}
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
