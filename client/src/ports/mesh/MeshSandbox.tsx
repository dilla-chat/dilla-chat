// @ts-nocheck
// /mesh — sandbox that mounts the ported handoff ChatApp inside our Vite app.
// Data flow mirrors /demo: ensureMockSession() activates the mock api+ws and
// seeds authStore; useTeamSync issues sync:init via the mock ws to populate
// the team/channel/member/presence stores; useMeshEagerLoad prefetches
// per-channel messages, DMs, and threads so ChatApp's flat MOCK_DATA snapshot
// is fully populated by the time it renders.

import { useEffect, useRef, useState } from 'react';
import ChatApp from './ChatApp';
import { MeshTopBar, MeshBottomBar, CommandPalette, SearchPalette } from './MeshChrome';
import Settings from './Settings';
import {
  NotificationStack,
  IncomingCall,
  SafetyCompare,
  AddPeerWizard,
  ConnectionBanner,
} from './Extras';
import { THEMES } from './themes';
import { useMeshData } from './useMeshData';
import { useMeshEagerLoad } from './useMeshEagerLoad';
import { useTeamStore } from '../../stores/teamStore';
import { useAuthStore } from '../../stores/authStore';
import { useTeamSync } from '../../hooks/useTeamSync';
import { ensureMockSession } from '../../services/mockSession';
import './chat.css';
import './mesh-chrome.css';
import './extras.css';
import './settings.css';

ensureMockSession();

// ChatApp does `const SettingsModal = window.Settings` and renders it
// when settings.open. Wire the ported Settings component onto window.
(window as unknown as { Settings: typeof Settings }).Settings = Settings;

export default function MeshSandbox() {
  const [cmdOpen, setCmdOpen] = useState(false);
  const [srchOpen, setSrchOpen] = useState(false);
  const [srchScope, setSrchScope] = useState<string | null>(null);
  // Column widths are tracked here so the ResizeHandle in ChatApp can drive
  // re-renders when the user drags the sidebar or members rail divider.
  const [sidebarW, setSidebarW] = useState(240);
  const [membersW, setMembersW] = useState(232);
  // Extras state: incoming call ring, safety-number compare modal, add-peer
  // wizard. ChatApp dispatches these via window events when triggered from
  // various menus / command palette entries.
  const [ringCall, setRingCall] = useState<{ from: string; kind: string } | null>(null);
  const [safetyId, setSafetyId] = useState<string | null>(null);
  const [addPeerOpen, setAddPeerOpen] = useState(false);

  useEffect(() => {
    const onRing = (e: Event) => setRingCall((e as CustomEvent).detail ?? { from: 'ada', kind: 'voice' });
    const onSafety = (e: Event) => setSafetyId((e as CustomEvent).detail ?? null);
    const onAddPeer = () => setAddPeerOpen(true);
    window.addEventListener('dilla:incoming-call', onRing);
    window.addEventListener('dilla:verify-safety', onSafety);
    window.addEventListener('dilla:add-peer', onAddPeer);
    return () => {
      window.removeEventListener('dilla:incoming-call', onRing);
      window.removeEventListener('dilla:verify-safety', onSafety);
      window.removeEventListener('dilla:add-peer', onAddPeer);
    };
  }, []);
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

  // Drive the same load flow as /demo: useTeamSync fetches the team snapshot
  // via the (mock) ws, useMeshEagerLoad prefetches per-channel data through
  // the (mock) api. Both end up writing to the same Zustand stores that
  // useMeshData reads from below.
  const activeTeamId = useTeamStore((s) => s.activeTeamId);
  useTeamSync(activeTeamId);
  // ChatApp captures data.MESSAGES into useState on first render and doesn't
  // re-derive when the underlying stores update. Wait until the eager loader
  // has finished fanning out so the captured snapshot is the real fixture,
  // not a partially-filled map.
  const { ready: messagesReady } = useMeshEagerLoad(activeTeamId);

  // The ChatApp reads window.MOCK_DATA on every render — overwrite with the
  // live-bridged shape produced by useMeshData (Zustand → handoff schema).
  const meshData = useMeshData();
  (window as unknown as { MOCK_DATA: typeof meshData }).MOCK_DATA = meshData;
  const activeTeam = useTeamStore((s) => (s.activeTeamId ? s.teams.get(s.activeTeamId) : undefined));
  const teamChannels = useTeamStore((s) => (s.activeTeamId ? s.channels.get(s.activeTeamId) : undefined));
  const authTeam = useAuthStore((s) => (activeTeamId ? s.teams.get(activeTeamId) : undefined));
  const nodeHost = (() => {
    const base = (authTeam as { baseUrl?: string } | undefined)?.baseUrl ?? '';
    if (!base) return 'local';
    try {
      return new URL(base).host || 'local';
    } catch {
      return 'local';
    }
  })();
  const nodeShort = nodeHost.split('.')[0] || 'local';
  const teamNameUpper = (activeTeam?.name ?? 'DILLA').toUpperCase();

  // Build the command palette entries from real channels (handoff list was
  // 'channel #design', 'channel #general', etc — hardcoded to the prototype).
  // Keeps the static encryption/account entries from the handoff list.
  const dynamicCommands = [
    ...((teamChannels ?? []).slice(0, 9).map((ch, i) => ({
      sec: 'NAVIGATE',
      cmd: `channel #${ch.name}`,
      hint: `⌘+${i + 1}`,
      channelId: ch.id,
    }))),
    { sec: 'VOICE', cmd: 'toggle mute', hint: 'M' },
    { sec: 'VOICE', cmd: 'toggle deafen', hint: 'D' },
    { sec: 'VOICE', cmd: 'disconnect', hint: '⌘+⇧+D' },
    { sec: 'ENCRYPTION', cmd: 'rotate session keys', hint: '' },
    { sec: 'ENCRYPTION', cmd: 'export identity backup', hint: '' },
    { sec: 'ACCOUNT', cmd: 'set custom status', hint: '' },
    { sec: 'ACCOUNT', cmd: 'sign out', hint: '⌘+⇧+Q' },
  ];

  // For now the demo runs as a single, non-federated node. The handoff
  // chrome (top bar 'MESH OK', bottom peer chunks, member panel 2-nodes
  // header) all key off `federated`. Flip it true once we wire a real
  // peer status feed from the server.
  const federated = false;

  const theme = THEMES.mesh;
  const opts = {
    density: 'regular',
    sidebar: sidebarW,
    members: membersW,
    federated,
    onSidebarChange: setSidebarW,
    onMembersChange: setMembersW,
  };
  const wrapStyle = THEMES.themeVars(theme, opts);

  return (
    <div className="mesh-wrap" style={wrapStyle}>
      <MeshTopBar
        onCmdK={() => setCmdOpen(true)}
        onSearch={() => setSrchOpen(true)}
        onHelp={() => {}}
        federated={federated}
        degraded={false}
        teamName={teamNameUpper}
        nodeName={nodeShort}
      />
      {messagesReady && (
        <ChatApp theme={theme} opts={opts} rich controller={controllerRef.current} />
      )}
      <MeshBottomBar voiceConnection={null} federated={federated} degraded={false} nodeHost={nodeHost} />
      <CommandPalette
        open={cmdOpen}
        onClose={() => setCmdOpen(false)}
        onPickChannel={(id: string) => controllerRef.current.pickChannel?.(id)}
        commands={dynamicCommands}
      />
      <SearchPalette
        open={srchOpen}
        onClose={() => setSrchOpen(false)}
        scope={srchScope}
      />
      {/* Toast notifications via dilla:notify */}
      <NotificationStack />
      {/* Connection-state banner via dilla:connection */}
      <ConnectionBanner />
      {/* Incoming call ring, safety-number compare, add-peer wizard.
          Each shows only when its corresponding state is set. */}
      {ringCall && (
        <IncomingCall
          call={ringCall}
          onAccept={() => setRingCall(null)}
          onDecline={() => setRingCall(null)}
        />
      )}
      {safetyId && (
        <SafetyCompare contactId={safetyId} onClose={() => setSafetyId(null)} />
      )}
      <AddPeerWizard open={addPeerOpen} onClose={() => setAddPeerOpen(false)} />
    </div>
  );
}
