import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
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
import { usePresenceStore, type UserPresence } from '../stores/presenceStore';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { useIsMobile } from '../hooks/useMediaQuery';
import { api, type VoicePeer } from '../services/api';
import { ws } from '../services/websocket';
import { initCrypto } from '../services/crypto';
import { unlockWithPrf } from '../services/keyStore';
import { fromBase64 } from '../services/cryptoCore';
import { useVoiceStore } from '../stores/voiceStore';
import './AppLayout.css';

export default function AppLayout() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { activeTeamId, activeChannelId, channels, setActiveChannel, setActiveTeam, teams: teamMap } = useTeamStore();
  const { teams, derivedKey } = useAuthStore();
  const { activeDMId, setActiveDM, dmChannels } = useDMStore();
  const { activeThreadId, threadPanelOpen, threads, setActiveThread, setThreadPanelOpen } = useThreadStore();
  const isMobile = useIsMobile();
  const [mobileTab, setMobileTab] = useState<MobileTab>('chat');
  const [showMembers, setShowMembers] = useState(true);
  const [showDMMembers, setShowDMMembers] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);

  // Redirect to join/setup if no teams
  useEffect(() => {
    if (teams.size === 0) {
      navigate('/join');
    }
  }, [teams, navigate]);

  // Restore API connections from persisted teams on mount
  const apiRestored = useRef(false);
  const authErrorFired = useRef(false);
  useEffect(() => {
    api.setAuthErrorHandler(() => {
      if (authErrorFired.current) return;
      authErrorFired.current = true;
      console.warn('Auth token expired — redirecting to login');
      navigate('/login');
    });
  }, [navigate]);

  useEffect(() => {
    if (apiRestored.current) return;
    apiRestored.current = true;
    console.log(`[AppLayout] Restoring API connections for ${teams.size} teams`);
    teams.forEach((entry, teamId) => {
      const baseUrl = (entry as { baseUrl?: string }).baseUrl;
      if (baseUrl) {
        api.addTeam(teamId, baseUrl);
        if (entry.token) api.setToken(teamId, entry.token);
        console.log(`[AppLayout] API restored: ${teamId} → ${baseUrl} (has token: ${!!entry.token})`);
      }
    });

    // Validate token is still accepted by the server
    const firstTeamId = teams.keys().next().value;
    if (firstTeamId) {
      api.getTeam(firstTeamId)
        .then(() => setAuthChecked(true))
        .catch(() => setAuthChecked(true)); // 401 → authErrorHandler fires redirect
    } else {
      setAuthChecked(true);
    }
  }, [teams]);

  // Re-initialize CryptoManager on mount when derivedKey was restored from sessionStorage
  const cryptoRestored = useRef(false);
  useEffect(() => {
    if (cryptoRestored.current || !derivedKey) return;
    cryptoRestored.current = true;

    (async () => {
      try {
        const prfKey = fromBase64(derivedKey);
        const identity = await unlockWithPrf(prfKey);
        await initCrypto(identity, derivedKey);
        console.log('[AppLayout] CryptoManager re-initialized from persisted derivedKey');
      } catch (e) {
        console.warn('[AppLayout] Failed to re-init crypto:', e);
      }
    })();
  }, [derivedKey]);

  // Auto-select first team if none active
  useEffect(() => {
    if (!activeTeamId && teams.size > 0) {
      const firstTeamId = teams.keys().next().value;
      if (firstTeamId) setActiveTeam(firstTeamId);
    }
  }, [activeTeamId, teams, setActiveTeam]);
  const [createChannelCategory, setCreateChannelCategory] = useState<string | undefined>(undefined);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [viewMode, setViewMode] = useState<'channels' | 'dms'>('channels');

  // Keep viewMode in sync: selecting a DM switches to DM mode, selecting a channel switches back.
  useEffect(() => {
    if (activeDMId && viewMode !== 'dms') {
      setViewMode('dms');
      setActiveChannel('');
    }
  }, [activeDMId]);

  useEffect(() => {
    if (activeChannelId && viewMode !== 'channels') {
      setViewMode('channels');
      setActiveDM(null);
    }
  }, [activeChannelId]);

  // Auto-switch to chat tab on mobile when a channel or DM is selected
  useEffect(() => {
    if (isMobile && (activeChannelId || activeDMId)) {
      setMobileTab('chat');
    }
  }, [isMobile, activeChannelId, activeDMId]);

  const [showNewDM, setShowNewDM] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [channelWidth, setChannelWidth] = useState(240);

  const handleChannelResize = useCallback((delta: number) => {
    setChannelWidth(prev => Math.min(Math.max(prev + delta, 180), 340));
  }, []);

  const { setTeam, setChannels, setMembers, setRoles } = useTeamStore();
  const { setPresences, updatePresence, setMyStatus, setMyCustomStatus } = usePresenceStore();
  const dataLoaded = useRef<Set<string>>(new Set());

  // Helper: normalize members from server snake_case to client camelCase
  const normalizeMembers = (data: Record<string, unknown>[]) =>
    data.map((m) => ({
      id: m.id as string,
      userId: (m.userId ?? m.user_id) as string,
      username: m.username as string,
      displayName: (m.displayName ?? m.display_name ?? '') as string,
      nickname: (m.nickname ?? '') as string,
      roles: (m.roles ?? []) as import('../stores/teamStore').Role[],
      statusType: (m.statusType ?? m.status_type ?? '') as string,
    }));

  // Helper: apply sync data to stores
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const applySyncData = (teamId: string, data: any) => {
    if (data.channels) {
      const channels = (data.channels as Record<string, unknown>[]).map((ch) => ({
        ...ch,
        teamId: ch.teamId ?? ch.team_id ?? teamId,
      })) as import('../stores/teamStore').Channel[];
      setChannels(teamId, channels);
    }
    if (data.team) setTeam(data.team as import('../stores/teamStore').Team);
    if (data.members) setMembers(teamId, normalizeMembers(data.members as Record<string, unknown>[]));
    if (data.roles) setRoles(teamId, data.roles as import('../stores/teamStore').Role[]);
    if (data.presences) {
      // Presences from sync:init come as a map of userId -> presence objects
      const presMap: Record<string, UserPresence> = {};
      const raw = data.presences;
      if (raw && typeof raw === 'object') {
        for (const [userId, p] of Object.entries(raw as Record<string, Record<string, unknown>>)) {
          presMap[userId] = {
            user_id: userId,
            status: (p.status ?? p.status_type ?? 'offline') as UserPresence['status'],
            custom_status: (p.custom_status ?? '') as string,
            last_active: (p.last_active ?? '') as string,
          };
        }
      }
      setPresences(teamId, presMap);
      // Sync own status
      const myUserId = (teams.get(teamId)?.user as { id?: string } | null)?.id;
      if (myUserId && presMap[myUserId]) {
        setMyStatus(presMap[myUserId].status);
        setMyCustomStatus(presMap[myUserId].custom_status || '');
      }
    }
    if (data.voice_states && typeof data.voice_states === 'object') {
      useVoiceStore.getState().setVoiceOccupants(data.voice_states as Record<string, VoicePeer[]>);
    }
    console.log(`[AppLayout] sync:init applied for team ${teamId}`);
  };

  // Fallback: load data via REST if WS sync fails
  const loadDataViaREST = (teamId: string) => {
    console.log(`[AppLayout] Falling back to REST data load for ${teamId}`);
    api.getChannels(teamId).then((data) => {
      const channels = (data as Record<string, unknown>[]).map((ch) => ({
        ...ch,
        teamId: ch.teamId ?? ch.team_id ?? teamId,
      })) as import('../stores/teamStore').Channel[];
      setChannels(teamId, channels);
    }).catch((err) => console.error('Failed to fetch channels:', err));

    api.getTeam(teamId).then((data) => {
      const team = data as import('../stores/teamStore').Team;
      if (team && team.id) setTeam(team);
    }).catch((err) => console.error('Failed to fetch team:', err));

    api.getMembers(teamId).then((data) => {
      setMembers(teamId, normalizeMembers(data as Record<string, unknown>[]));
    }).catch((err) => console.error('Failed to fetch members:', err));

    api.getRoles(teamId).then((data) => {
      setRoles(teamId, data as import('../stores/teamStore').Role[]);
    }).catch((err) => console.error('Failed to fetch roles:', err));

    api.getPresences(teamId).then((data) => {
      setPresences(teamId, data);
      const myUserId = (teams.get(teamId)?.user as { id?: string } | null)?.id;
      if (myUserId && data[myUserId]) {
        setMyStatus(data[myUserId].status);
        setMyCustomStatus(data[myUserId].custom_status || '');
      }
    }).catch((err) => console.error('Failed to fetch presences:', err));
  };

  // Handle ws:connected — request sync:init to load all team data
  useEffect(() => {
    if (!activeTeamId) return;
    const teamId = activeTeamId;

    const doSyncInit = () => {
      console.log(`[AppLayout] WS connected for team ${teamId}, requesting sync:init`);
      ws.request(teamId, 'sync:init').then((data: unknown) => {
        dataLoaded.current.add(teamId);
        applySyncData(teamId, data as Record<string, unknown>);
      }).catch((err: Error) => {
        console.warn('[AppLayout] sync:init failed, falling back to REST:', err.message);
        if (!dataLoaded.current.has(teamId)) {
          dataLoaded.current.add(teamId);
          loadDataViaREST(teamId);
        }
      });
    };

    const unsub = ws.on('ws:connected', (payload: { teamId?: string }) => {
      if (payload?.teamId !== teamId) return;
      doSyncInit();
    });

    // If WS is already connected (e.g. after HMR), trigger sync immediately
    if (ws.isConnected(teamId) && !dataLoaded.current.has(teamId)) {
      doSyncInit();
    }

    return () => { unsub(); };
  }, [activeTeamId]);

  // Connect WebSocket when team becomes active
  const wsConnected = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!activeTeamId) return;
    if (wsConnected.current.has(activeTeamId)) return;

    const connInfo = api.getConnectionInfo(activeTeamId);
    if (!connInfo?.token) return;

    const wsUrl = connInfo.baseUrl
      .replace(/^http:/, 'ws:')
      .replace(/^https:/, 'wss:')
      + '/ws';

    console.log(`[AppLayout] Connecting WebSocket for team ${activeTeamId} → ${wsUrl}`);
    ws.connect(activeTeamId, wsUrl, connInfo.token);
    wsConnected.current.add(activeTeamId);
  }, [activeTeamId]);

  // Upload identity blob once per session for cross-device recovery
  const blobUploaded = useRef(false);
  useEffect(() => {
    if (blobUploaded.current || !activeTeamId || !derivedKey) return;
    if (!dataLoaded.current.has(activeTeamId)) return;
    blobUploaded.current = true;

    (async () => {
      try {
        const { exportIdentityBlob } = await import('../services/keyStore');
        const blob = await exportIdentityBlob();
        if (!blob) return;
        const allServers: string[] = [];
        teams.forEach((entry) => {
          if (entry.baseUrl) allServers.push(entry.baseUrl);
        });
        for (const [teamId, entry] of teams) {
          const { baseUrl, token } = entry;
          if (!baseUrl || !token) continue;
          const jwt = api.getConnectionInfo(teamId)?.token || token;
          try {
            await fetch(`${baseUrl}/api/v1/identity/blob`, {
              method: 'PUT',
              headers: { 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ blob, servers: allServers }),
            });
            console.log(`[AppLayout] Identity blob uploaded to ${baseUrl}`);
          } catch (e) {
            console.warn(`[AppLayout] Blob upload to ${baseUrl} failed:`, e);
          }
        }
      } catch (e) {
        console.warn('[AppLayout] Blob upload skipped:', e);
      }
    })();
  }, [activeTeamId, derivedKey, dataLoaded.current.size]);

  // Subscribe to presence WebSocket events
  useEffect(() => {
    const unsubPresence = ws.on('presence:changed', (payload: Record<string, string>) => {
      const teamId = payload.team_id ?? activeTeamId;
      if (teamId && payload.user_id) {
        // Normalize server's status_type → status
        const normalized: UserPresence = {
          user_id: payload.user_id,
          status: (payload.status_type || payload.status || 'offline') as UserPresence['status'],
          custom_status: payload.status_text ?? payload.custom_status ?? '',
          last_active: payload.last_active ?? '',
        };
        updatePresence(teamId, normalized);
      }
    });

    // Global voice presence: track who's in voice channels across the team
    const unsubVoiceJoin = ws.on('voice:user-joined', (payload: { channel_id: string; user_id: string; username: string; muted?: boolean; deafened?: boolean; screen_sharing?: boolean; webcam_sharing?: boolean }) => {
      if (payload.channel_id && payload.user_id) {
        useVoiceStore.getState().addVoiceOccupant(payload.channel_id, {
          user_id: payload.user_id,
          username: payload.username,
          muted: payload.muted ?? false,
          deafened: payload.deafened ?? false,
          speaking: false,
          voiceLevel: 0,
          screen_sharing: payload.screen_sharing ?? false,
          webcam_sharing: payload.webcam_sharing ?? false,
        });
      }
    });

    const unsubVoiceLeft = ws.on('voice:user-left', (payload: { channel_id: string; user_id: string }) => {
      if (payload.channel_id && payload.user_id) {
        useVoiceStore.getState().removeVoiceOccupant(payload.channel_id, payload.user_id);
      }
    });

    // Global voice state updates: keep sidebar occupants in sync
    const unsubMuteUpdate = ws.on('voice:mute-update', (payload: { channel_id: string; user_id: string; muted: boolean; deafened: boolean }) => {
      if (payload.channel_id && payload.user_id) {
        useVoiceStore.getState().updateVoiceOccupant(payload.channel_id, payload.user_id, {
          muted: payload.muted,
          deafened: payload.deafened,
        });
      }
    });

    const unsubScreenUpdate = ws.on('voice:screen-update', (payload: { channel_id: string; user_id: string; sharing: boolean }) => {
      if (payload.channel_id && payload.user_id) {
        useVoiceStore.getState().updateVoiceOccupant(payload.channel_id, payload.user_id, {
          screen_sharing: payload.sharing,
        });
      }
    });

    const unsubWebcamUpdate = ws.on('voice:webcam-update', (payload: { channel_id: string; user_id: string; sharing: boolean }) => {
      if (payload.channel_id && payload.user_id) {
        useVoiceStore.getState().updateVoiceOccupant(payload.channel_id, payload.user_id, {
          webcam_sharing: payload.sharing,
        });
      }
    });

    return () => {
      unsubPresence();
      unsubVoiceJoin();
      unsubVoiceLeft();
      unsubMuteUpdate();
      unsubScreenUpdate();
      unsubWebcamUpdate();
    };
  }, [activeTeamId, updatePresence]);

  // Get current user info from auth store
  const currentTeamEntry = activeTeamId ? teams.get(activeTeamId) : null;
  const currentUser = currentTeamEntry?.user as { id?: string; username?: string; display_name?: string } | null;
  const currentUserId = currentUser?.id ?? '';
  const username = currentUser?.username ?? 'User';
  const displayName = currentUser?.display_name;

  // Find active channel info
  const teamChannels = activeTeamId ? (Array.isArray(channels.get(activeTeamId)) ? channels.get(activeTeamId)! : []) : [];
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
          <span className="channel-sidebar-header-name">
            {isDMMode ? t('dm.title', 'Direct Messages') : (activeTeamId ? teamMap.get(activeTeamId)?.name : null) ?? t('app.name')}
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
            className={`sidebar-tab ${!isDMMode ? 'active' : ''}`}
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
      <TitleBar />
      <div className={`app-layout-main ${isMobile ? 'mobile' : ''}`}>
      {!isMobile && (
        <>
          <div className="left-panels">
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
      <div className="content-wrapper">
        <div className="content-header">
          {isDMMode && activeDM ? (
            <>
              <span className="content-header-icon">
                {activeDM.is_group ? <Group width={20} height={20} strokeWidth={2} /> : <ChatBubble width={20} height={20} strokeWidth={2} />}
              </span>
              <span className="content-header-name">
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
                <SearchBar onJumpToMessage={handleJumpToMessage} />
                {activeDM.is_group && (
                  <button
                    className={`header-action-btn ${showDMMembers ? 'active' : ''}`}
                    onClick={() => setShowDMMembers(v => !v)}
                    title={t('members.toggle', 'Toggle Member List')}
                  >
                    <Group width={20} height={20} strokeWidth={2} />
                  </button>
                )}
              </div>
            </>
          ) : !isDMMode && activeChannel ? (
            <>
              <span className="content-header-icon">
                {activeChannel.type === 'voice' ? <SoundHigh width={20} height={20} strokeWidth={2} /> : <span className="channel-tilde">~</span>}
              </span>
              <span className="content-header-name">{activeChannel.name}</span>
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
                <SearchBar onJumpToMessage={handleJumpToMessage} />
                <button
                  className={`header-action-btn ${showMembers ? 'active' : ''}`}
                  onClick={() => setShowMembers(v => !v)}
                  title={t('members.toggle', 'Toggle Member List')}
                >
                  <Group width={20} height={20} strokeWidth={2} />
                </button>
              </div>
            </>
          ) : (
            <>
              <span className="content-header-name">{t('app.name')}</span>
              <div className="content-header-actions">
                <SearchBar onJumpToMessage={handleJumpToMessage} />
                <button
                  className={`header-action-btn ${showMembers ? 'active' : ''}`}
                  onClick={() => setShowMembers(!showMembers)}
                  title={t('members.toggle', 'Toggle Member List')}
                >
                  <Group width={20} height={20} strokeWidth={2} />
                </button>
              </div>
            </>
          )}
        </div>

        <div className="content-body">
          <div className="content-area">
            {isDMMode && activeDM ? (
              <DMView dm={activeDM} currentUserId={currentUserId} showMembers={showDMMembers} />
            ) : !isDMMode && activeChannel && activeChannel.type === 'voice' ? (
              <VoiceChannel channel={activeChannel} />
            ) : !isDMMode && activeChannel ? (
              <ChannelView channel={activeChannel} />
            ) : (
              <div className="message-area">
                <div className="message-area-empty">
                  <p>
                    {isDMMode
                      ? t('dm.noDMs', 'No direct messages yet')
                      : t('channels.selectChannel', 'Select a channel to start chatting')}
                  </p>
                </div>
              </div>
            )}
          </div>

          {threadPanelOpen && activeThread && (
            <ThreadPanel thread={activeThread} onClose={handleCloseThread} />
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
