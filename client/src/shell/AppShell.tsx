// @ts-nocheck
// AppShell — the chrome + ChatApp shell. Pure presentation; assumes Zustand
// stores have been (or will be) populated by the caller's data hooks
// (useTeamSync / useEagerLoad). Used by both the demo at /mesh and the
// production /app route.

import { useEffect, useRef, useState } from 'react';
import ChatApp from './ChatApp';
import { TopBar, BottomBar, CommandPalette, SearchPalette } from './Chrome';
import Settings from './Settings';
import {
  NotificationStack,
  IncomingCall,
  SafetyCompare,
  AddPeerWizard,
  ConnectionBanner,
} from './Extras';
import { THEMES } from './themes';
import { useShellData } from './useShellData';
import { useTeamStore } from '../stores/teamStore';
import { useAuthStore } from '../stores/authStore';
import { useMeshStore } from '../stores/meshStore';
import { useVoiceConnection } from '../hooks/useVoiceConnection';
import './chat.css';
import './chrome.css';
import './extras.css';
import './settings.css';

// ChatApp does `const SettingsModal = window.Settings` and renders it when
// settings.open. Wire the ported Settings component onto window once at
// module load (idempotent).
(window as unknown as { Settings: typeof Settings }).Settings = Settings;

interface AppShellProps {
  /** Set when the underlying message/DM/thread stores are populated.
   *  ChatApp captures data.MESSAGES into useState on first render and
   *  doesn't re-derive on store updates, so the caller must gate the
   *  mount until the snapshot is full. */
  ready: boolean;
}

export default function AppShell({ ready }: AppShellProps) {
  const [cmdOpen, setCmdOpen] = useState(false);
  const [srchOpen, setSrchOpen] = useState(false);
  const [srchScope, setSrchScope] = useState<string | null>(null);

  const openShortcuts = () =>
    window.dispatchEvent(
      new CustomEvent('dilla:open-settings', { detail: { mode: 'user', tab: 'keys' } }),
    );
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

  // ChatApp reads window.MOCK_DATA on every render — overwrite with the
  // live-bridged shape produced by useShellData (Zustand → handoff schema).
  const shellData = useShellData();
  (window as unknown as { MOCK_DATA: typeof shellData }).MOCK_DATA = shellData;

  const activeTeamId = useTeamStore((s) => s.activeTeamId);
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

  // Command palette entries from real channels.
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

  // Federation flag drives top bar 'MESH OK', bottom peer chunks, and the
  // member panel 2-nodes header. Comes from useMeshStore which useShellSync
  // populates from `federation:peer-status` WS events. `federated` flips on
  // as soon as the team has any peers configured; `degraded` is when some
  // of them are unreachable.
  const peersTotal = useMeshStore((s) => s.peersTotal);
  const meshStatus = useMeshStore((s) => s.status);
  const federated = peersTotal > 0;
  const degraded = meshStatus === 'degraded';

  // BottomBar shows mic/headphones state when voice is live. The bridged
  // data is the source of truth for the channel name lookup.
  const voice = useVoiceConnection();
  const voiceCh = teamChannels?.find((c) => c.id === voice.currentChannelId);
  const voiceForBar = voice.connected && voiceCh
    ? { channelId: voice.currentChannelId, channel: voiceCh.name, muted: voice.muted, deafened: voice.deafened }
    : null;

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
      <TopBar
        onCmdK={() => setCmdOpen(true)}
        onSearch={() => setSrchOpen(true)}
        onHelp={openShortcuts}
        federated={federated}
        degraded={degraded}
        teamName={teamNameUpper}
        nodeName={nodeShort}
      />
      {ready && (
        <ChatApp theme={theme} opts={opts} rich controller={controllerRef.current} />
      )}
      <BottomBar voiceConnection={voiceForBar} federated={federated} degraded={degraded} nodeHost={nodeHost} />
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
      <NotificationStack />
      <ConnectionBanner />
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
