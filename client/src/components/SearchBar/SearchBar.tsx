import { useState, useRef, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { IconSearch, IconX } from '@tabler/icons-react';
import { useMessageStore, type Message } from '../../stores/messageStore';
import './SearchBar.css';

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

  // Close dropdown on click outside
  useEffect(() => {
    if (!showDropdown) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setFocused(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showDropdown]);

  return (
    <div className="header-search" ref={containerRef}>
      <div className={`header-search-input-wrapper ${focused ? 'focused' : ''}`}>
        <IconSearch className="header-search-icon" size={16} stroke={1.75} />
        <input
          ref={inputRef}
          type="text"
          className="header-search-input"
          placeholder={t('search.placeholder', 'Search messages...')}
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => setFocused(true)}
        />
        {query && (
          <button className="header-search-clear" onClick={handleClear}>
            <IconX size={14} stroke={1.75} />
          </button>
        )}
      </div>

      {showDropdown && (
        <div className="header-search-dropdown">
          {results.length === 0 ? (
            <div className="search-bar-no-results">
              {t('search.noResults', 'No results found')}
            </div>
          ) : (
            <>
              <div className="search-bar-result-count micro">
                {t('search.results', '{{count}} results', { count: results.length })}
              </div>
              {results.map((result) => (
                <button
                  key={result.message.id}
                  className="search-bar-result"
                  onClick={() => handleResultClick(result)}
                  type="button"
                >
                  <div className="search-result-header">
                    <span className="search-result-author">
                      {result.message.username}
                    </span>
                    <span className="search-result-time">
                      {new Date(result.message.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <div className="search-result-content">
                    {result.message.content.substring(0, result.matchStart)}
                    <mark className="search-result-highlight">
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
        </div>
      )}
    </div>
  );
}
