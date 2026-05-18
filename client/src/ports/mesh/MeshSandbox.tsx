// @ts-nocheck
// Minimal entry that mounts the ported handoff ChatApp inside our Vite app.
// Step 1 of the design-first migration: get the JSX rendering with its own
// mocked data. Later steps will replace mocks with real Zustand bindings.

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
import { useTeamStore } from '../../stores/teamStore';
import { useAuthStore } from '../../stores/authStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { useMessageStore } from '../../stores/messageStore';
import { useDMStore } from '../../stores/dmStore';
import { useThreadStore } from '../../stores/threadStore';
import { useVoiceStore } from '../../stores/voiceStore';
import {
  DEMO_TEAM_ID,
  DEMO_CURRENT_USER_ID,
  MOCK_TEAM,
  MOCK_CHANNELS,
  MOCK_MEMBERS,
  MOCK_ROLES,
  MOCK_PRESENCES,
  MOCK_GENERAL_MESSAGES,
  MOCK_WELCOME_MESSAGES,
  MOCK_DM_CHANNELS,
  MOCK_DM_MESSAGES,
  MOCK_THREADS,
  MOCK_THREAD_MESSAGES,
  MOCK_VOICE_STATES,
} from '../../services/mockData';
import './chat.css';
import './mesh-chrome.css';
import './extras.css';
import './settings.css';

// Seed the stores synchronously at module load if empty so that ChatApp
// (which captures data.MESSAGES into useState on its first render) sees a
// populated map instead of an empty one. Idempotent across re-imports.
function seedStoresIfEmpty() {
  const { teams, setTeam, setChannels, setMembers, setRoles, setActiveTeam, setActiveChannel } =
    useTeamStore.getState();
  if (teams.size > 0) return;
  // Seed authStore first so useMeshData can resolve the current user id
  // for the byId['thim'] alias and the "mine" reaction flag.
  const authStore = useAuthStore.getState();
  authStore.setDerivedKey('demo-passphrase');
  authStore.setPublicKey('demo-public-key');
  authStore.addTeam(
    DEMO_TEAM_ID,
    'demo-token',
    { id: DEMO_CURRENT_USER_ID, username: 'alice', display_name: 'Alice' },
    MOCK_TEAM as unknown as Record<string, unknown>,
  );
  setTeam(MOCK_TEAM);
  setChannels(DEMO_TEAM_ID, MOCK_CHANNELS);
  setMembers(DEMO_TEAM_ID, MOCK_MEMBERS);
  setRoles(DEMO_TEAM_ID, MOCK_ROLES);
  setActiveTeam(DEMO_TEAM_ID);
  setActiveChannel('ch-2');
  usePresenceStore.getState().setPresences(DEMO_TEAM_ID, MOCK_PRESENCES);
  const msgStore = useMessageStore.getState();
  msgStore.prependMessages('ch-1', MOCK_WELCOME_MESSAGES);
  msgStore.prependMessages('ch-2', MOCK_GENERAL_MESSAGES);
  msgStore.setHasMore('ch-1', false);
  msgStore.setHasMore('ch-2', false);
  const dmStore = useDMStore.getState();
  dmStore.setDMChannels(DEMO_TEAM_ID, MOCK_DM_CHANNELS);
  for (const [dmId, messages] of Object.entries(MOCK_DM_MESSAGES)) {
    dmStore.setDMMessages(dmId, messages);
  }
  const threadStore = useThreadStore.getState();
  threadStore.setThreads('ch-2', MOCK_THREADS);
  for (const [threadId, msgs] of Object.entries(MOCK_THREAD_MESSAGES)) {
    threadStore.setThreadMessages(threadId, msgs);
  }
  useVoiceStore.getState().setVoiceOccupants(MOCK_VOICE_STATES);
}

seedStoresIfEmpty();

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

  // Step 2: SERVERS + CHANNELS come from our useTeamStore (everything else
  // is still mocked). The ChatApp reads window.MOCK_DATA, so we overwrite
  // that with the live-bridged shape just before its render.
  const meshData = useMeshData();
  (window as unknown as { MOCK_DATA: typeof meshData }).MOCK_DATA = meshData;

  // Chrome strings derived from our stores instead of the handoff hardcodes
  // ('BERRALITOS', 'gbg-1', 'gbg-1.dilla.local'). We pull the active team
  // name and parse the baseUrl host as the node identifier.
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
      <ChatApp theme={theme} opts={opts} rich controller={controllerRef.current} />
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
