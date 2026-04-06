import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useLocation } from 'react-router-dom';
import { Hashtag, ChatBubble, Group, SoundHigh, Lock, Settings } from 'iconoir-react';
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
import { telemetryClient } from '../services/telemetryClient';
import ContentErrorBoundary from '../components/ErrorBoundary/ContentErrorBoundary';
import './AppLayout.css';

export default function AppLayout() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { activeTeamId, activeChannelId, channels, setActiveChannel, teams: teamMap } = useTeamStore();
  const { teams, derivedKey } = useAuthStore();
  const { activeDMId, setActiveDM, dmChannels } = useDMStore();
  const { activeThreadId, threadPanelOpen, threads, setActiveThread, setThreadPanelOpen } = useThreadStore();
  const isMobile = useIsMobile();
  const [mobileTab, setMobileTab] = useState<MobileTab>('chat');
  const [showMembers, setShowMembers] = useState(true);
  const [showDMMembers, setShowDMMembers] = useState(false);

  useCustomTheme();

  // --- Extracted hooks ---
  const { cryptoReady } = useCryptoRestore();
  const { authChecked, dataLoaded } = useTeamSync(activeTeamId);

  // Redirect to join/setup if no teams — wait until auth is validated so we
  // don't redirect during the brief window before persisted state is confirmed.
  useEffect(() => {
    if (authChecked && teams.size === 0) {
      navigate('/join');
    }
  }, [teams, navigate, authChecked]);
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
  const [channelWidth, setChannelWidth] = useState(240);

  const handleChannelResize = useCallback((delta: number) => {
    setChannelWidth(prev => Math.min(Math.max(prev + delta, 240), 400));
  }, []);

  // Get current user info from auth store
  const currentTeamEntry = activeTeamId ? teams.get(activeTeamId) : null;
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

  // Pre-compute content header for S3358 (no nested ternaries in JSX)
  const renderContentHeader = () => {
    if (isDMMode && activeDM) {
      return (
        <>
          <span className="content-header-icon">
            {activeDM.is_group ? <Group width={20} height={20} strokeWidth={2} /> : <ChatBubble width={20} height={20} strokeWidth={2} />}
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
              <Lock width={14} height={14} strokeWidth={2} />
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
            {activeDM.is_group && (
              <button
                className={`header-action-btn ${showDMMembers ? 'active' : ''}`}
                onClick={() => setShowDMMembers(v => !v)}
                title={t('members.toggle', 'Toggle Member List')}
              >
                <Group width={20} height={20} strokeWidth={2} />
              </button>
            )}
            <SearchBar onJumpToMessage={handleJumpToMessage} />
          </div>
        </>
      );
    }
    if (!isDMMode && activeChannel) {
      return (
        <>
          <span className="content-header-icon">
            {activeChannel.type === 'voice' ? <SoundHigh width={20} height={20} strokeWidth={2} /> : <span className="channel-tilde">~</span>}
          </span>
          <span className="content-header-name title">{activeChannel.name}</span>
          {derivedKey && (
            <span className="content-header-encrypted" title="End-to-end encrypted">
              <Lock width={14} height={14} strokeWidth={2} />
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
              className={`header-action-btn ${showMembers ? 'active' : ''}`}
              onClick={() => setShowMembers(v => !v)}
              title={t('members.toggle', 'Toggle Member List')}
            >
              <Group width={20} height={20} strokeWidth={2} />
            </button>
            <SearchBar onJumpToMessage={handleJumpToMessage} />
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
            <Group width={20} height={20} strokeWidth={2} />
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
        <div className="message-area-empty">
          <p>
            {isDMMode
              ? t('dm.noDMs', 'No direct messages yet')
              : t('channels.selectChannel', 'Select a channel to start chatting')}
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
      // Focus the inline search input
      const searchInput = document.querySelector('.header-search-input') as HTMLInputElement | null;
      searchInput?.focus();
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
  if (teams.size === 0) {
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
    <div className={`channel-sidebar ${isMobile ? 'mobile-fullwidth' : ''}`} style={isMobile ? undefined : { width: channelWidth }}>
      <div className="channel-sidebar-header">
        <div className="channel-sidebar-header-top">
          <span className="channel-sidebar-header-name title truncate">
            {isDMMode ? t('dm.title', 'Direct Messages') : (activeTeamId && teamMap.get(activeTeamId)?.name) || t('app.name')}
          </span>
          <button
            className="sidebar-settings-btn"
            onClick={() => navigate('/app/settings')}
            title={t('teams.settings', 'Team Settings')}
            style={isDMMode ? { visibility: 'hidden' } : undefined}
          >
            <Settings width={18} height={18} strokeWidth={2} />
          </button>
        </div>
        <div className="channel-sidebar-tabs">
          <button
            className={`sidebar-tab ${isDMMode ? '' : 'active'}`}
            onClick={switchToChannels}
            title={t('channels.uncategorized', 'Channels')}
          >
            <Hashtag width={16} height={16} strokeWidth={2} /> {t('channels.title', 'Kanals')}
          </button>
          <button
            className={`sidebar-tab ${isDMMode ? 'active' : ''}`}
            onClick={switchToDMs}
            title={t('dm.title', 'Direct Messages')}
          >
            <ChatBubble width={16} height={16} strokeWidth={2} /> {t('dm.short', 'PMs')}
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
      <div className={`app-layout-main ${isMobile ? 'mobile' : ''}`}>
      {!isMobile && (
        <>
          <div className="left-panels" style={{ width: 72 + channelWidth }}>
            <div className="left-panels-top">
              <TeamSidebar />
              {channelSidebarContent}
            </div>

            <div className="left-panels-bottom">
              <VoiceControls />
              <UserPanel
                username={username}
                displayName={displayName}
                onSettingsClick={() => navigate('/app/user-settings')}
              />
            </div>
          </div>

          <ResizeHandle onResize={handleChannelResize} />
        </>
      )}

      {isMobile && mobileTab === 'teams' && (
        <div className="mobile-tab-content">
          <TeamSidebar />
        </div>
      )}

      {isMobile && mobileTab === 'channels' && (
        <div className="mobile-tab-content">
          {channelSidebarContent}
        </div>
      )}

      {isMobile && mobileTab === 'members' && (
        <div className="mobile-tab-content">
          <MemberList />
        </div>
      )}

      {(!isMobile || mobileTab === 'chat') && (
      <div id="main-content" className="content-wrapper">
        <div className="content-header">
          {renderContentHeader()}
        </div>

        <div className="content-body">
          <div className="content-area">
            {renderContentArea()}
          </div>

          {threadPanelOpen && activeThread && (
            <ContentErrorBoundary fallbackLabel="Thread panel failed to load.">
              <ThreadPanel thread={activeThread} onClose={handleCloseThread} />
            </ContentErrorBoundary>
          )}

          {!isMobile && !isDMMode && showMembers && <MemberList />}
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
    </>
  );
}
