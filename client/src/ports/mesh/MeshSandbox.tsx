// @ts-nocheck
// Minimal entry that mounts the ported handoff ChatApp inside our Vite app.
// Step 1 of the design-first migration: get the JSX rendering with its own
// mocked data. Later steps will replace mocks with real Zustand bindings.

import { useEffect, useRef, useState } from 'react';
import ChatApp from './ChatApp';
import { MeshTopBar, MeshBottomBar, CommandPalette, SearchPalette } from './MeshChrome';
import { THEMES } from './themes';
import './chat.css';
import './mesh-chrome.css';
import './extras.css';
import './settings.css';

export default function MeshSandbox() {
  const [cmdOpen, setCmdOpen] = useState(false);
  const [srchOpen, setSrchOpen] = useState(false);
  const [srchScope, setSrchScope] = useState<string | null>(null);
  const controllerRef = useRef<{ pickChannel?: (id: string) => void; getVoiceConn?: () => unknown }>({});

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tgt = e.target as HTMLElement | null;
      const inField =
        tgt?.matches?.('input, textarea, [contenteditable="true"]') ?? false;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdOpen((o) => !o);
        setSrchOpen(false);
      } else if (e.key === '/' && !inField && !cmdOpen && !srchOpen) {
        e.preventDefault();
        setSrchOpen(true);
      } else if (e.key === 'Escape') {
        setCmdOpen(false);
        setSrchOpen(false);
      }
    }
    function onSrch(e: Event) {
      const detail = (e as CustomEvent).detail ?? null;
      setSrchScope(detail);
      setSrchOpen(true);
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('dilla:open-search', onSrch);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('dilla:open-search', onSrch);
    };
  }, [cmdOpen, srchOpen]);

  const theme = THEMES.mesh;
  const opts = {
    density: 'regular',
    sidebar: 240,
    members: 232,
    federated: true,
    onSidebarChange: () => {},
    onMembersChange: () => {},
  };
  const wrapStyle = THEMES.themeVars(theme, opts);

  return (
    <div className="mesh-wrap" style={wrapStyle}>
      <MeshTopBar
        onCmdK={() => setCmdOpen(true)}
        onSearch={() => setSrchOpen(true)}
        onHelp={() => {}}
        federated
        degraded={false}
      />
      <ChatApp theme={theme} opts={opts} rich controller={controllerRef.current} />
      <MeshBottomBar voiceConnection={null} federated degraded={false} />
      <CommandPalette
        open={cmdOpen}
        onClose={() => setCmdOpen(false)}
        onPickChannel={(id: string) => controllerRef.current.pickChannel?.(id)}
      />
      <SearchPalette
        open={srchOpen}
        onClose={() => setSrchOpen(false)}
        scope={srchScope}
      />
    </div>
  );
}
