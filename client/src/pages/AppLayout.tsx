import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useLocation } from 'react-router-dom';
import { IconHash, IconMessage, IconUsers, IconVolume, IconSettings, IconShield, IconSearch, IconMessageCircle, IconBookmark, IconPin } from '@tabler/icons-react';
import TeamSidebar from '../components/TeamSidebar/TeamSidebar';
import ChannelList from '../components/ChannelList/ChannelList';
import DMList from '../components/DMList/DMList';
import DMView from '../components/DMView/DMView';
import NewDMModal from '../components/DMList/NewDMModal';
import VoiceControls from '../components/VoiceControls/VoiceControls';
import VoiceChannel from '../components/VoiceChannel/VoiceChannel';
import UserPanel from '../components/UserPanel/UserPanel';
import MemberList from '../components/MemberList/MemberList';
import CreateChannel from '../components/CreateChannel/CreateChannel';
import ThreadPanel from '../components/ThreadPanel/ThreadPanel';
import SearchBar from '../components/SearchBar/SearchBar';
import ShortcutsModal from '../components/ShortcutsModal/ShortcutsModal';
import QuickSwitcher, { type QuickSwitcherItem } from '../components/QuickSwitcher/QuickSwitcher';
import ResizeHandle from '../components/ResizeHandle/ResizeHandle';
import MobileTabBar, { type MobileTab } from '../components/MobileTabBar/MobileTabBar';
import ChannelView from './ChannelView';
import TitleBar from '../components/TitleBar/TitleBar';
import { useTeamStore } from '../stores/teamStore';
import { useAuthStore } from '../stores/authStore';
import { useDMStore, type DMChannel } from '../stores/dmStore';
import { useThreadStore } from '../stores/threadStore';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { useIsMobile } from '../hooks/useMediaQuery';
import { useTeamSync } from '../hooks/useTeamSync';
import { useCryptoRestore } from '../hooks/useCryptoRestore';
import { useIdentityBackup } from '../hooks/useIdentityBackup';
import { usePresenceEvents } from '../hooks/usePresenceEvents';
import { useCustomTheme } from '../hooks/useCustomTheme';
import { useShellSync } from '../hooks/useShellSync';
import { telemetryClient } from '../services/telemetryClient';
import { ws } from '../services/websocket';
import ContentErrorBoundary from '../components/ErrorBoundary/ContentErrorBoundary';
import { useLayoutStore } from '../stores/layoutStore';
import MeshTopBar from '../components/MeshChrome/MeshTopBar';
import MeshBottomBar from '../components/MeshChrome/MeshBottomBar';
import CommandPalette, { type PaletteCommand } from '../components/CommandPalette/CommandPalette';
import SearchPalette, { type SearchHit } from '../components/SearchPalette/SearchPalette';
import ConnectionBanner from '../components/ConnectionBanner/ConnectionBanner';
import AddPeerWizard from '../components/AddPeerWizard/AddPeerWizard';
import SafetyCompare from '../components/SafetyCompare/SafetyCompare';
import ForwardModal, { type ForwardTarget, type ForwardSource } from '../components/ForwardModal/ForwardModal';
import IncomingCall from '../components/IncomingCall/IncomingCall';
import { useMeshStore } from '../stores/meshStore';
import { useUserSettingsStore } from '../stores/userSettingsStore';
import { useMessageStore } from '../stores/messageStore';
import './AppLayout.css';

function matchMessagesInChannel(
  q: string,
  chId: string,
  channelName: string,
  msgs: Array<{ id: string; content: string; username: string; createdAt: string | number; deleted?: boolean }>,
  hits: SearchHit[],
  cap: number,
): boolean {
  for (const m of msgs) {
    if (m.deleted) continue;
    if (!m.content.toLowerCase().includes(q)) continue;
    hits.push({
      id: m.id,
      channelId: chId,
      channelName,
      author: m.username,
      timestamp: new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
      body: m.content,
    });
    if (hits.length >= cap) return true;
  }
  return false;
}

function searchMessages(
  query: string,
  scope: string,
  teamChannels: Array<{ id: string; name: string }>,
  activeChannel: { id: string } | null,
): SearchHit[] {
  const q = query.toLowerCase();
  const messages = useMessageStore.getState().messages;
  const hits: SearchHit[] = [];
  const filterChannelId = scope === 'channel' ? (activeChannel?.id ?? null) : null;
  for (const [chId, msgs] of messages) {
    if (filterChannelId && chId !== filterChannelId) continue;
    const channel = teamChannels.find((c) => c.id === chId);
    if (!channel) continue;
    if (matchMessagesInChannel(q, chId, channel.name, msgs, hits, 60)) return hits;
  }
  return hits;
}

export default function AppLayout() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { activeTeamId, activeChannelId, channels, setActiveChannel, teams: teamMap } = useTeamStore();
  const { teams: authTeams, derivedKey } = useAuthStore();
  const { activeDMId, setActiveDM, dmChannels } = useDMStore();
  const { activeThreadId, threadPanelOpen, threads, setActiveThread, setThreadPanelOpen } = useThreadStore();
  const isMobile = useIsMobile();
  const [mobileTab, setMobileTab] = useState<MobileTab>('chat');
  const [showMembers, setShowMembers] = useState(true);
  const [showDMMembers, setShowDMMembers] = useState(false);

  useCustomTheme();
  useShellSync();

  const {
    sidebarWidth,
    membersWidth,
    topBarEnabled,
    bottomBarEnabled,
    nudgeSidebarWidth,
    nudgeMembersWidth,
  } = useLayoutStore();

  // --- Extracted hooks ---
  const { cryptoReady } = useCryptoRestore();
  const { authChecked, dataLoaded } = useTeamSync(activeTeamId);

  // Redirect to join/setup if no teams — wait until auth is validated so we
  // don't redirect during the brief window before persisted state is confirmed.
  useEffect(() => {
    if (authChecked && authTeams.size === 0) {
      navigate('/join');
    }
  }, [authTeams, navigate, authChecked]);
  useIdentityBackup(activeTeamId, dataLoaded);
  usePresenceEvents(activeTeamId);

  // Install global error handlers for telemetry
  useEffect(() => {
    telemetryClient.install();
  }, []);

  // Record route changes as telemetry breadcrumbs
  useEffect(() => {
    telemetryClient.addBreadcrumb('navigation', location.pathname);
  }, [location.pathname]);

  const [createChannelCategory, setCreateChannelCategory] = useState<string | undefined>(undefined);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [viewMode, setViewMode] = useState<'channels' | 'dms'>('channels');

  // Keep viewMode in sync: selecting a DM switches to DM mode, selecting a channel switches back.
  useEffect(() => {
    if (activeDMId && viewMode !== 'dms') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional cascading update to keep view mode in sync
      setViewMode('dms');
      setActiveChannel('');
    }
  }, [activeDMId, setActiveChannel, viewMode]);

  useEffect(() => {
    if (activeChannelId && viewMode !== 'channels') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional cascading update to keep view mode in sync
      setViewMode('channels');
      setActiveDM(null);
    }
  }, [activeChannelId, setActiveDM, viewMode]);

  // Auto-switch to chat tab on mobile when a channel or DM is selected
  useEffect(() => {
    if (isMobile && (activeChannelId || activeDMId)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: mobile tab must follow active selection
      setMobileTab('chat');
    }
  }, [isMobile, activeChannelId, activeDMId]);

  const [showNewDM, setShowNewDM] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [searchPaletteOpen, setSearchPaletteOpen] = useState(false);
  const [addPeerOpen, setAddPeerOpen] = useState(false);
  const [safetyCompareOpen, setSafetyCompareOpen] = useState(false);
  const [forwardSource, setForwardSource] = useState<ForwardSource | null>(null);
  const [incomingCall, setIncomingCall] = useState<{
    callerName: string;
    channelName?: string;
    channelId?: string;
  } | null>(null);

  // Listen for mesh:* events from the top bar, bottom bar, and other components
  useEffect(() => {
    const openCmd = () => setCommandPaletteOpen(true);
    const openSearch = () => setSearchPaletteOpen(true);
    const openAddPeer = () => setAddPeerOpen(true);
    const openSafety = () => setSafetyCompareOpen(true);
    const openForward = (e: Event) => {
      const detail = (e as CustomEvent<ForwardSource>).detail;
      if (detail) setForwardSource(detail);
    };
    const openIncoming = (e: Event) => {
      const detail = (e as CustomEvent<{ callerName: string; channelName?: string; channelId?: string }>).detail;
      if (detail) setIncomingCall(detail);
    };
    globalThis.addEventListener('mesh:open-command-palette', openCmd);
    globalThis.addEventListener('mesh:open-search', openSearch);
    globalThis.addEventListener('mesh:open-add-peer', openAddPeer);
    globalThis.addEventListener('mesh:open-safety-compare', openSafety);
    globalThis.addEventListener('mesh:open-forward', openForward);
    globalThis.addEventListener('mesh:incoming-call', openIncoming);
    return () => {
      globalThis.removeEventListener('mesh:open-command-palette', openCmd);
      globalThis.removeEventListener('mesh:open-search', openSearch);
      globalThis.removeEventListener('mesh:open-add-peer', openAddPeer);
      globalThis.removeEventListener('mesh:open-safety-compare', openSafety);
      globalThis.removeEventListener('mesh:open-forward', openForward);
      globalThis.removeEventListener('mesh:incoming-call', openIncoming);
    };
  }, []);

  // Get current user info from auth store
  const currentTeamEntry = activeTeamId ? authTeams.get(activeTeamId) : null;
  const currentUser = currentTeamEntry?.user ?? null;
  const currentUserId = currentUser?.id ?? '';
  const username = currentUser?.username ?? 'User';
  const displayName = currentUser?.display_name;

  // Find active channel info
  const teamChannels = useMemo(() => {
    if (!activeTeamId) return [];
    const ch = channels.get(activeTeamId);
    return Array.isArray(ch) ? ch : [];
  }, [activeTeamId, channels]);
  const activeChannel = teamChannels.find((c) => c.id === activeChannelId);

  // Find active DM info
  const teamDMs = activeTeamId ? (dmChannels[activeTeamId] ?? []) : [];
  const activeDM = teamDMs.find((d) => d.id === activeDMId);

  // Find active thread across all channel threads
  const activeThread = (() => {
    if (!activeThreadId) return null;
    for (const channelThreads of Object.values(threads)) {
      const found = channelThreads.find((th) => th.id === activeThreadId);
      if (found) return found;
    }
    return null;
  })();

  const handleCloseThread = () => {
    setActiveThread(null);
    setThreadPanelOpen(false);
  };

  const handleCreateChannel = (category?: string) => {
    setCreateChannelCategory(category);
    setShowCreateChannel(true);
  };

  const switchToChannels = () => {
    setViewMode('channels');
    setActiveDM(null);
  };

  const switchToDMs = () => {
    setViewMode('dms');
    setActiveChannel('');
  };

  const handleDMCreated = (dm: DMChannel) => {
    setActiveDM(dm.id);
    setViewMode('dms');
  };

  const isDMMode = viewMode === 'dms';

  // Build CommandPalette commands from current state
  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const cmds: PaletteCommand[] = [];

    // NAVIGATE — current team's channels
    for (const ch of teamChannels.filter((c) => c.type === 'text').slice(0, 8)) {
      cmds.push({
        id: `nav.channel.${ch.id}`,
        label: `Open #${ch.name}`,
        hint: ch.topic || undefined,
        section: 'NAVIGATE',
        run: () => setActiveChannel(ch.id),
      });
    }

    // VOICE — voice channels
    for (const ch of teamChannels.filter((c) => c.type === 'voice').slice(0, 4)) {
      cmds.push({
        id: `voice.${ch.id}`,
        label: `Join ${ch.name}`,
        section: 'VOICE',
        run: () => setActiveChannel(ch.id),
      });
    }
    cmds.push(
      {
        id: 'voice.simulate-incoming',
        label: 'Simulate: incoming call',
        hint: 'dev',
        section: 'VOICE',
        run: () =>
          globalThis.dispatchEvent(
            new CustomEvent('mesh:incoming-call', {
              detail: { callerName: 'Ada Lovelace', channelName: 'voice-lounge' },
            }),
          ),
      },
      // FEDERATION
      {
        id: 'fed.add-peer',
        label: 'Add a federation peer',
        hint: 'opens 4-step wizard',
        section: 'FEDERATION',
        run: () =>
          globalThis.dispatchEvent(new CustomEvent('mesh:open-add-peer')),
      },
      {
        id: 'fed.peers',
        label: 'Show peer status',
        hint: 'opens federation settings',
        section: 'FEDERATION',
        run: () => navigate('/app/settings'),
      },
      {
        id: 'fed.simulate-degraded',
        label: 'Simulate: peer drop',
        hint: 'dev',
        section: 'FEDERATION',
        run: () => useMeshStore.getState().setStatus('degraded'),
      },
      {
        id: 'fed.simulate-ok',
        label: 'Simulate: peers OK',
        hint: 'dev',
        section: 'FEDERATION',
        run: () => useMeshStore.getState().setStatus('ok'),
      },
      // ENCRYPTION
      {
        id: 'enc.verify',
        label: 'Verify safety number',
        hint: 'side-by-side fingerprint compare',
        section: 'ENCRYPTION',
        run: () =>
          globalThis.dispatchEvent(new CustomEvent('mesh:open-safety-compare')),
      },
      {
        id: 'enc.settings',
        label: 'Open privacy & encryption settings',
        section: 'ENCRYPTION',
        run: () => navigate('/app/user-settings'),
      },
      // ACCOUNT
      {
        id: 'acct.settings',
        label: 'Open user settings',
        section: 'ACCOUNT',
        run: () => navigate('/app/user-settings'),
      },
      {
        id: 'acct.theme.mesh',
        label: 'Switch to mesh theme',
        section: 'ACCOUNT',
        run: () => useUserSettingsStore.getState().setTheme('mesh'),
      },
      {
        id: 'acct.theme.dark',
        label: 'Switch to dark theme',
        section: 'ACCOUNT',
        run: () => useUserSettingsStore.getState().setTheme('dark'),
      },
    );

    return cmds;
  }, [teamChannels, setActiveChannel, navigate]);

  // Pre-compute content header for S3358 (no nested ternaries in JSX)
  const renderContentHeader = () => {
    if (isDMMode && activeDM) {
      return (
        <>
          <span className="content-header-icon">
            {activeDM.is_group ? <IconUsers size={20} stroke={1.75} /> : <IconMessage size={20} stroke={1.75} />}
          </span>
          <span className="content-header-name title">
            {activeDM.is_group
              ? ((activeDM as unknown as { name?: string }).name || activeDM.members.map((m) => m.display_name || m.username).join(', '))
              : (() => {
                  const other = activeDM.members.find((m) => m.user_id !== currentUserId);
                  return other ? (other.display_name || other.username) : t('dm.title', 'Direct Message');
                })()}
          </span>
          {derivedKey && (
            <span className="content-header-encrypted" title="End-to-end encrypted">
              <IconShield size={11} stroke={1.75} /> E2E
            </span>
          )}
          {activeDM.is_group && (
            <>
              <span className="content-header-divider" />
              <span className="content-header-topic">
                {t('dm.members', '{{count}} members', { count: activeDM.members.length })}
              </span>
            </>
          )}
          <div className="content-header-actions">
            <button
              type="button"
              className="btn btn--ghost btn--icon btn--sm"
              onClick={() => globalThis.dispatchEvent(new CustomEvent('mesh:open-saved'))}
              title={t('header.saved', 'Saved messages')}
            >
              <IconBookmark size={18} stroke={1.75} />
            </button>
            {activeDM.is_group && (
              <button
                className={`header-action-btn ${showDMMembers ? 'active' : ''}`}
                onClick={() => setShowDMMembers(v => !v)}
                title={t('members.toggle', 'Toggle Member List')}
              >
                <IconUsers size={20} stroke={1.75} />
              </button>
            )}
            <button
              type="button"
              className="btn btn--ghost btn--icon btn--sm"
              onClick={() =>
                globalThis.dispatchEvent(new CustomEvent('mesh:open-search'))
              }
              title={t('search.placeholder', 'Search')}
            >
              <IconSearch size={18} stroke={1.75} />
            </button>
          </div>
        </>
      );
    }
    if (!isDMMode && activeChannel) {
      return (
        <>
          <span className="content-header-icon">
            {activeChannel.type === 'voice' ? <IconVolume size={18} stroke={1.75} /> : <span className="channel-tilde">#</span>}
          </span>
          <span className="content-header-name title">{activeChannel.name}</span>
          {derivedKey && (
            <span className="content-header-encrypted" title="End-to-end encrypted">
              <IconShield size={11} stroke={1.75} /> E2E
            </span>
          )}
          {activeChannel.topic && (
            <>
              <span className="content-header-divider" />
              <span className="content-header-topic">{activeChannel.topic}</span>
            </>
          )}
          <div className="content-header-actions">
            <button
              type="button"
              className="btn btn--ghost btn--icon btn--sm"
              onClick={() => globalThis.dispatchEvent(new CustomEvent('mesh:open-threads'))}
              title={t('header.threads', 'Threads')}
            >
              <IconMessageCircle size={18} stroke={1.75} />
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--icon btn--sm"
              onClick={() => globalThis.dispatchEvent(new CustomEvent('mesh:open-saved'))}
              title={t('header.saved', 'Saved messages')}
            >
              <IconBookmark size={18} stroke={1.75} />
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--icon btn--sm"
              onClick={() => globalThis.dispatchEvent(new CustomEvent('mesh:open-pinned'))}
              title={t('header.pinned', 'Pinned messages')}
            >
              <IconPin size={18} stroke={1.75} />
            </button>
            <button
              className={`header-action-btn ${showMembers ? 'active' : ''}`}
              onClick={() => setShowMembers(v => !v)}
              title={t('members.toggle', 'Toggle Member List')}
            >
              <IconUsers size={20} stroke={1.75} />
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--icon btn--sm"
              onClick={() =>
                globalThis.dispatchEvent(new CustomEvent('mesh:open-search'))
              }
              title={t('search.placeholder', 'Search')}
            >
              <IconSearch size={18} stroke={1.75} />
            </button>
          </div>
        </>
      );
    }
    return (
      <>
        <span className="content-header-name title">{t('app.name')}</span>
        <div className="content-header-actions">
          <button
            className={`header-action-btn ${showMembers ? 'active' : ''}`}
            onClick={() => setShowMembers(!showMembers)}
            title={t('members.toggle', 'Toggle Member List')}
          >
            <IconUsers size={20} stroke={1.75} />
          </button>
          <SearchBar onJumpToMessage={handleJumpToMessage} />
        </div>
      </>
    );
  };

  // Pre-compute content area for S3358
  const renderContentArea = () => {
    if (!cryptoReady) {
      return (
        <div className="message-area">
          <div className="message-area-empty">
            <p>{t('app.loading', 'Loading...')}</p>
          </div>
        </div>
      );
    }
    if (isDMMode && activeDM) {
      return (
        <ContentErrorBoundary fallbackLabel="Direct messages failed to load.">
          <DMView dm={activeDM} currentUserId={currentUserId} showMembers={showDMMembers} />
        </ContentErrorBoundary>
      );
    }
    if (!isDMMode && activeChannel?.type === 'voice') {
      return (
        <ContentErrorBoundary fallbackLabel="Voice channel failed to load.">
          <VoiceChannel channel={activeChannel} />
        </ContentErrorBoundary>
      );
    }
    if (!isDMMode && activeChannel) {
      return (
        <ContentErrorBoundary fallbackLabel="Channel failed to load.">
          <ChannelView channel={activeChannel} />
        </ContentErrorBoundary>
      );
    }
    return (
      <div className="message-area">
        <div className="empty-state">
          <div className="empty-state-icon">
            <IconMessage size={48} stroke={1.25} />
          </div>
          <h3 className="empty-state-title">
            {isDMMode
              ? t('dm.noDMs', 'No direct messages yet')
              : t('channels.selectChannel', 'Select a kanal')}
          </h3>
          <p className="empty-state-description">
            {isDMMode
              ? t('dm.noDMsHint', 'Start a conversation by opening a new direct message')
              : t('channels.selectChannelHint', 'Pick a channel from the sidebar to start chatting')}
          </p>
        </div>
      </div>
    );
  };

  const handleJumpToMessage = useCallback(
    (channelId: string, messageId: string) => {
      // Switch to the channel containing the message
      if (channelId !== activeChannelId) {
        setActiveChannel(channelId);
        setViewMode('channels');
      }
      // Scroll to the message after a short delay for render
      setTimeout(() => {
        const el = document.getElementById(`msg-${messageId}`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.classList.add('message-highlight');
          setTimeout(() => el.classList.remove('message-highlight'), 2000);
        }
      }, 100);
    },
    [activeChannelId, setActiveChannel],
  );

  const handleQuickSwitch = useCallback(
    (item: QuickSwitcherItem) => {
      if (item.type === 'dm') {
        setActiveDM(item.id);
      } else {
        setActiveChannel(item.id);
      }
      setQuickSwitcherOpen(false);
    },
    [setActiveChannel, setActiveDM],
  );

  const handleNavigateChannel = useCallback(
    (direction: 'up' | 'down') => {
      const textChannels = teamChannels.filter((c) => c.type === 'text');
      if (textChannels.length === 0) return;
      const currentIdx = textChannels.findIndex((c) => c.id === activeChannelId);
      let nextIdx: number;
      if (direction === 'up') {
        nextIdx = currentIdx <= 0 ? textChannels.length - 1 : currentIdx - 1;
      } else {
        nextIdx = currentIdx >= textChannels.length - 1 ? 0 : currentIdx + 1;
      }
      setActiveChannel(textChannels[nextIdx].id);
    },
    [teamChannels, activeChannelId, setActiveChannel],
  );

  useKeyboardShortcuts({
    onOpenSearch: () => {
      setQuickSwitcherOpen((prev) => !prev);
    },
    onClosePanel: () => {
      if (shortcutsOpen) {
        setShortcutsOpen(false);
      } else if (threadPanelOpen) {
        setActiveThread(null);
        setThreadPanelOpen(false);
      }
    },
    onShowShortcuts: () => setShortcutsOpen(true),
    onNavigateChannel: handleNavigateChannel,
  });

  // Wait for auth validation before rendering
  if (!authChecked) return null;

  // Show onboarding when no teams are joined
  if (authTeams.size === 0) {
    return (
      <>
        <TitleBar />
        <div className="app-layout-main">
          <div className="page" style={{ margin: 'auto', maxWidth: 480, padding: '3rem 2rem' }}>
            <img src="/brand/icon.svg" alt="Dilla" style={{ width: 80, height: 80, marginBottom: 8 }} />
            <h1>{t('app.welcomeBack', 'Welcome to Dilla')}</h1>
            <p style={{ opacity: 0.7 }}>{t('app.noServers', 'You haven\'t joined any servers yet. Join an existing server or set up your own.')}</p>
            <div className="form" style={{ marginTop: '1rem' }}>
              <button className="btn-primary" onClick={() => navigate('/join')}>
                {t('auth.joinTeam', 'Join a Server')}
              </button>
              <button className="btn-secondary" onClick={() => navigate('/setup')}>
                {t('setup.title', 'Set Up a Server')}
              </button>
            </div>
          </div>
        </div>
      </>
    );
  }

  const channelSidebarContent = (
    <div className={`channel-sidebar ${isMobile ? 'mobile-fullwidth' : ''}`}>
      <div className="channel-sidebar-header">
        <div className="channel-sidebar-header-top">
          <span className="channel-sidebar-header-name title truncate">
            {isDMMode ? t('dm.title', 'Direct Messages') : (activeTeamId && teamMap.get(activeTeamId)?.name) || t('app.name')}
          </span>
          <button
            className="btn btn--ghost btn--icon btn--sm"
            onClick={() => navigate('/app/settings')}
            title={t('teams.settings', 'Team Settings')}
            style={isDMMode ? { visibility: 'hidden' } : undefined}
          >
            <IconSettings size={18} stroke={1.75} />
          </button>
        </div>
        {!isDMMode && activeTeamId && (
          <div className="channel-sidebar-node" title="Federation status">
            {(authTeams.get(activeTeamId)?.baseUrl ?? '')
              .replace(/^https?:\/\//, '')
              .replace(/\/$/, '')}
            {' · '}
            <span className="channel-sidebar-node-status">MESH OK</span>
          </div>
        )}
        <div className="channel-sidebar-tabs">
          <button
            className={`sidebar-tab ${isDMMode ? '' : 'active'}`}
            onClick={switchToChannels}
            title={t('channels.uncategorized', 'Channels')}
          >
            <IconHash size={16} stroke={1.75} /> {t('channels.title', 'Kanals')}
          </button>
          <button
            className={`sidebar-tab ${isDMMode ? 'active' : ''}`}
            onClick={switchToDMs}
            title={t('dm.title', 'Direct Messages')}
          >
            <IconMessage size={16} stroke={1.75} /> {t('dm.short', 'PMs')}
          </button>
        </div>
      </div>

      {isDMMode ? (
        <DMList currentUserId={currentUserId} onNewDM={() => setShowNewDM(true)} />
      ) : (
        <ChannelList onCreateChannel={handleCreateChannel} />
      )}
    </div>
  );

  return (
    <>
      <a href="#main-content" className="skip-to-content">
        {t('a11y.skipToContent', 'Skip to content')}
      </a>
      <TitleBar />

      <div
        className={`app-layout-main ${isMobile ? 'mobile' : ''}`}
        data-topbar={topBarEnabled || undefined}
        data-bottombar={bottomBarEnabled || undefined}
      >
        {!isMobile && topBarEnabled && <MeshTopBar />}

        <ConnectionBanner />

        {!isMobile && (
          <div
            className="app-grid-shell"
            style={{
              // 6 tracks: rail | sidebar | handle | main | handle | members
              // The handle tracks are 4px (visible drag area); when the
              // members panel is hidden, both the handle and members
              // tracks collapse to 0px.
              gridTemplateColumns: `var(--rail-w) ${sidebarWidth}px 4px 1fr ${
                !isDMMode && showMembers ? `4px ${membersWidth}px` : '0px 0px'
              }`,
            }}
          >
            <div className="app-grid-rail">
              <TeamSidebar />
            </div>

            <div className="app-grid-sidebar">
              <div className="app-grid-sidebar-top">{channelSidebarContent}</div>
              <div className="app-grid-sidebar-bottom">
                <VoiceControls />
                <UserPanel
                  username={username}
                  displayName={displayName}
                  onSettingsClick={() => navigate('/app/user-settings')}
                />
              </div>
            </div>

            <ResizeHandle onResize={nudgeSidebarWidth} />

            <div id="main-content" className="content-wrapper">
              <div className="content-header">{renderContentHeader()}</div>
              <div className="content-body">
                <div className="content-area">{renderContentArea()}</div>
                {threadPanelOpen && activeThread && (
                  <ContentErrorBoundary fallbackLabel="Thread panel failed to load.">
                    <ThreadPanel thread={activeThread} onClose={handleCloseThread} />
                  </ContentErrorBoundary>
                )}
              </div>
            </div>

            {!isDMMode && showMembers && (
              <>
                <ResizeHandle onResize={nudgeMembersWidth} side="right" />
                <div className="app-grid-members">
                  <MemberList />
                </div>
              </>
            )}
          </div>
        )}

        {isMobile && mobileTab === 'teams' && (
          <div className="mobile-tab-content">
            <TeamSidebar />
          </div>
        )}

        {isMobile && mobileTab === 'channels' && (
          <div className="mobile-tab-content">{channelSidebarContent}</div>
        )}

        {isMobile && mobileTab === 'members' && (
          <div className="mobile-tab-content">
            <MemberList />
          </div>
        )}

        {isMobile && mobileTab === 'chat' && (
          <div id="main-content" className="content-wrapper">
            <div className="content-header">{renderContentHeader()}</div>
            <div className="content-body">
              <div className="content-area">{renderContentArea()}</div>
              {threadPanelOpen && activeThread && (
                <ContentErrorBoundary fallbackLabel="Thread panel failed to load.">
                  <ThreadPanel thread={activeThread} onClose={handleCloseThread} />
                </ContentErrorBoundary>
              )}
            </div>
          </div>
        )}

        {isMobile && (
          <div className="mobile-bottom-controls">
            <VoiceControls />
            <UserPanel
              username={username}
              displayName={displayName}
              onSettingsClick={() => navigate('/app/user-settings')}
            />
            <MobileTabBar activeTab={mobileTab} onTabChange={setMobileTab} />
          </div>
        )}

        {!isMobile && bottomBarEnabled && <MeshBottomBar />}

        {showCreateChannel && (
          <CreateChannel
            defaultCategory={createChannelCategory}
            onClose={() => setShowCreateChannel(false)}
          />
        )}

        {showNewDM && (
          <NewDMModal
            currentUserId={currentUserId}
            onClose={() => setShowNewDM(false)}
            onDMCreated={handleDMCreated}
          />
        )}

        {shortcutsOpen && (
          <ShortcutsModal onClose={() => setShortcutsOpen(false)} />
        )}
      </div>

      <QuickSwitcher
        open={quickSwitcherOpen}
        onClose={() => setQuickSwitcherOpen(false)}
        onSelect={handleQuickSwitch}
      />

      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        commands={paletteCommands}
      />

      <IncomingCall
        open={incomingCall !== null}
        callerName={incomingCall?.callerName ?? ''}
        channelName={incomingCall?.channelName}
        onAccept={() => {
          // H-16: voice signaling now carries channel_id through the
          // voice:incoming-call event. Switching to the channel via the
          // existing dilla:pickchannel pathway pulls the user into the
          // ChatApp where the voice-dock join button is reachable.
          // (Auto-joining the SFU here would skip the dock's mic/cam
          // pre-flight — best left to the user.)
          const cid = incomingCall?.channelId;
          if (cid) {
            globalThis.dispatchEvent(new CustomEvent('dilla:pickchannel', { detail: cid }));
          }
          setIncomingCall(null);
        }}
        onDecline={() => setIncomingCall(null)}
      />

      <AddPeerWizard
        open={addPeerOpen}
        onClose={() => setAddPeerOpen(false)}
        onComplete={(peer) => {
          useMeshStore.getState().setPeers(
            useMeshStore.getState().peersConnected + 1,
            useMeshStore.getState().peersTotal + 1,
          );
          useMeshStore.getState().setStatus('ok');
          useMeshStore.getState().showConnectionBanner({
            kind: 'restored',
            message: `Peer ${peer.label} added`,
          });
          setTimeout(() => useMeshStore.getState().hideConnectionBanner(), 4000);
        }}
      />

      <SafetyCompare
        open={safetyCompareOpen}
        yours="57842 19034 88291 60017 33920 11458 90442 17763"
        theirs="57842 19034 88291 60017 33920 11458 90442 17763"
        yourName={`@${username}`}
        theirName="@peer"
        onClose={() => setSafetyCompareOpen(false)}
        onMarkVerified={() => {
          setSafetyCompareOpen(false);
          useMeshStore.getState().showConnectionBanner({
            kind: 'restored',
            message: 'Safety number verified',
          });
          setTimeout(() => useMeshStore.getState().hideConnectionBanner(), 3000);
        }}
        onMarkMismatch={() => {
          setSafetyCompareOpen(false);
          useMeshStore.getState().showConnectionBanner({
            kind: 'error',
            message: 'Safety number mismatch — stop messaging this contact',
          });
        }}
      />

      <ForwardModal
        open={forwardSource !== null}
        source={forwardSource}
        targets={(() => {
          const tgts: ForwardTarget[] = [];
          for (const ch of teamChannels) {
            if (ch.type === 'text') {
              tgts.push({ id: ch.id, label: ch.name, kind: 'channel' });
            }
          }
          for (const dm of teamDMs) {
            const otherName = dm.is_group
              ? dm.members.map((m) => m.display_name || m.username).join(', ')
              : dm.members.find((m) => m.user_id !== currentUserId)?.username ?? dm.id;
            tgts.push({ id: dm.id, label: otherName, kind: 'dm' });
          }
          return tgts;
        })()}
        onClose={() => setForwardSource(null)}
        onForward={(target) => {
          if (!activeTeamId || !forwardSource) return;
          // Compose a forwarded message body: keep the source body, prepend an attribution.
          const body = `> from ${forwardSource.author} (${forwardSource.timestamp})\n${forwardSource.body}`;
          if (target.kind === 'channel') {
            ws.sendMessage(activeTeamId, target.id, body);
          } else {
            ws.sendDMMessage(activeTeamId, target.id, body);
          }
          setForwardSource(null);
        }}
      />

      <SearchPalette
        open={searchPaletteOpen}
        onClose={() => setSearchPaletteOpen(false)}
        scopedChannelName={activeChannel?.name ?? null}
        search={(query, scope) => searchMessages(query, scope, teamChannels, activeChannel ?? null)}
        onSelectHit={(hit) => handleJumpToMessage(hit.channelId, hit.id)}
      />
    </>
  );
}
