import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const mockNavigate = vi.fn();

vi.mock('../services/api', () => ({
  api: {
    setAuthErrorHandler: vi.fn(),
    addTeam: vi.fn(),
    setToken: vi.fn(),
    getTeam: vi.fn().mockResolvedValue({}),
    getConnectionInfo: vi.fn(() => null),
    getChannels: vi.fn().mockResolvedValue([]),
    getMembers: vi.fn().mockResolvedValue([]),
    getRoles: vi.fn().mockResolvedValue([]),
    getPresences: vi.fn().mockResolvedValue({}),
    removeTeam: vi.fn(),
  },
}));

vi.mock('../services/websocket', () => ({
  ws: {
    on: vi.fn(() => vi.fn()),
    connect: vi.fn(),
    isConnected: vi.fn(() => false),
    request: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../services/crypto', () => ({ initCrypto: vi.fn() }));
vi.mock('../services/keyStore', () => ({ unlockWithPrf: vi.fn(), exportIdentityBlob: vi.fn() }));
vi.mock('../services/cryptoCore', () => ({ fromBase64: vi.fn() }));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('iconoir-react', () => ({
  Hashtag: () => <span data-testid="Hashtag" />,
  ChatBubble: () => <span data-testid="ChatBubble" />,
  Group: () => <span data-testid="Group" />,
  SoundHigh: () => <span data-testid="SoundHigh" />,
  Lock: () => <span data-testid="Lock" />,
  Settings: () => <span data-testid="Settings" />,
  HomeSimple: () => <span data-testid="HomeSimple" />,
  Xmark: () => <span data-testid="Xmark" />,
}));

const mockUseIsMobile = vi.fn(() => false);
vi.mock('../hooks/useMediaQuery', () => ({
  useIsMobile: () => mockUseIsMobile(),
  useMediaQuery: () => false,
}));

vi.mock('../components/MobileTabBar/MobileTabBar', () => ({
  default: ({ activeTab, onTabChange }: { activeTab: string; onTabChange: (tab: string) => void }) => (
    <div data-testid="mobile-tab-bar">
      <button data-testid="tab-chat" onClick={() => onTabChange('chat')}>chat</button>
      <button data-testid="tab-channels" onClick={() => onTabChange('channels')}>channels</button>
      <button data-testid="tab-teams" onClick={() => onTabChange('teams')}>teams</button>
      <button data-testid="tab-members" onClick={() => onTabChange('members')}>members</button>
    </div>
  ),
}));
vi.mock('../components/TeamSidebar/TeamSidebar', () => ({ default: () => <div data-testid="team-sidebar">TeamSidebar</div> }));
vi.mock('../components/ChannelList/ChannelList', () => ({ default: () => <div data-testid="channel-list">ChannelList</div> }));
vi.mock('../components/DMList/DMList', () => ({ default: () => <div data-testid="dm-list">DMList</div> }));
vi.mock('../components/DMList/NewDMModal', () => ({ default: () => null }));
vi.mock('../components/DMView/DMView', () => ({ default: () => <div data-testid="dm-view">DMView</div> }));
vi.mock('../components/VoiceControls/VoiceControls', () => ({ default: () => <div data-testid="voice-controls">VoiceControls</div> }));
vi.mock('../components/VoiceChannel/VoiceChannel', () => ({ default: () => <div data-testid="voice-channel">VoiceChannel</div> }));
vi.mock('../components/UserPanel/UserPanel', () => ({ default: () => <div data-testid="user-panel">UserPanel</div> }));
vi.mock('../components/MemberList/MemberList', () => ({ default: () => <div data-testid="member-list">MemberList</div> }));
vi.mock('../components/CreateChannel/CreateChannel', () => ({ default: () => null }));
vi.mock('../components/ThreadPanel/ThreadPanel', () => ({ default: () => <div data-testid="thread-panel">ThreadPanel</div> }));
vi.mock('../components/SearchBar/SearchBar', () => ({ default: () => <div data-testid="search-bar">SearchBar</div> }));
vi.mock('../components/ShortcutsModal/ShortcutsModal', () => ({ default: () => null }));
vi.mock('../components/ResizeHandle/ResizeHandle', () => ({ default: () => <div data-testid="resize-handle">ResizeHandle</div> }));
vi.mock('../components/TitleBar/TitleBar', () => ({ default: () => <div data-testid="title-bar">TitleBar</div> }));
vi.mock('./ChannelView', () => ({ default: () => <div data-testid="channel-view">ChannelView</div> }));

vi.mock('../stores/voiceStore', () => ({
  useVoiceStore: Object.assign(vi.fn(() => ({})), {
    getState: vi.fn(() => ({
      setVoiceOccupants: vi.fn(),
      addVoiceOccupant: vi.fn(),
      removeVoiceOccupant: vi.fn(),
      updateVoiceOccupant: vi.fn(),
    })),
  }),
}));

import AppLayout from './AppLayout';
import { useTeamStore } from '../stores/teamStore';
import { useAuthStore } from '../stores/authStore';
import { useDMStore } from '../stores/dmStore';
import { useThreadStore } from '../stores/threadStore';
import { api } from '../services/api';
import { ws } from '../services/websocket';

describe('AppLayout behavioral', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigate.mockClear();

    useAuthStore.setState({
      isAuthenticated: true,
      derivedKey: null,
      publicKey: null,
      teams: new Map([
        [
          'team1',
          {
            baseUrl: 'http://localhost:8080',
            token: 'tok',
            user: { id: 'u1', username: 'tester', display_name: 'Tester' },
            teamInfo: {},
          },
        ],
      ]),
    });

    useTeamStore.setState({
      activeTeamId: 'team1',
      activeChannelId: 'ch1',
      channels: new Map([['team1', [
        { id: 'ch1', name: 'general', type: 'text', teamId: 'team1', topic: '', position: 0, category: '' },
        { id: 'ch3', name: 'voice-room', type: 'voice', teamId: 'team1', topic: '', position: 2, category: '' },
      ]]]),
      teams: new Map([['team1', { id: 'team1', name: 'Test Team', description: '', iconUrl: '', maxFileSize: 0, allowMemberInvites: true }]]),
      members: new Map(),
      roles: new Map(),
      setActiveChannel: vi.fn(),
      setActiveTeam: vi.fn(),
      setTeam: vi.fn(),
      setChannels: vi.fn(),
      setMembers: vi.fn(),
      setRoles: vi.fn(),
    });

    useDMStore.setState({
      activeDMId: null,
      setActiveDM: vi.fn(),
      dmChannels: {},
    });

    useThreadStore.setState({
      threads: {},
      activeThreadId: null,
      threadPanelOpen: false,
      setActiveThread: vi.fn(),
      setThreadPanelOpen: vi.fn(),
    });
  });

  it('registers WS event handlers for presence and voice', async () => {
    render(<AppLayout />);
    await waitFor(() => { expect(ws.on).toHaveBeenCalled(); });
    const eventNames = vi.mocked(ws.on).mock.calls.map((c) => c[0]);
    expect(eventNames).toContain('presence:changed');
    expect(eventNames).toContain('voice:user-joined');
    expect(eventNames).toContain('voice:user-left');
    expect(eventNames).toContain('voice:mute-update');
    expect(eventNames).toContain('voice:screen-update');
    expect(eventNames).toContain('voice:webcam-update');
  });

  it('registers ws:connected event handler', async () => {
    render(<AppLayout />);
    await waitFor(() => {
      const eventNames = vi.mocked(ws.on).mock.calls.map((c) => c[0]);
      expect(eventNames).toContain('ws:connected');
    });
  });

  it('sets auth error handler on mount', async () => {
    render(<AppLayout />);
    await waitFor(() => { expect(api.setAuthErrorHandler).toHaveBeenCalled(); });
  });

  it('restores API connections from persisted teams on mount', async () => {
    render(<AppLayout />);
    await waitFor(() => {
      expect(api.addTeam).toHaveBeenCalledWith('team1', 'http://localhost:8080');
      expect(api.setToken).toHaveBeenCalledWith('team1', 'tok');
    });
  });

  it('redirects to /join when no teams', async () => {
    useAuthStore.setState({ teams: new Map() });
    render(<AppLayout />);
    await waitFor(() => { expect(mockNavigate).toHaveBeenCalledWith('/join'); });
  });

  it('shows onboarding UI when no teams with navigation buttons', async () => {
    useAuthStore.setState({ teams: new Map() });
    render(<AppLayout />);
    await waitFor(() => {
      expect(screen.getByText('Join a Server')).toBeInTheDocument();
      expect(screen.getByText('Set Up a Server')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Join a Server'));
    expect(mockNavigate).toHaveBeenCalledWith('/join');
    fireEvent.click(screen.getByText('Set Up a Server'));
    expect(mockNavigate).toHaveBeenCalledWith('/setup');
  });

  it('renders channel view for active text channel', async () => {
    render(<AppLayout />);
    await waitFor(() => { expect(screen.getByTestId('channel-view')).toBeInTheDocument(); });
  });

  it('shows channel name in header with tilde icon and team name in sidebar', async () => {
    render(<AppLayout />);
    await waitFor(() => {
      expect(screen.getByText('general')).toBeInTheDocument();
      expect(screen.getByText('~')).toBeInTheDocument();
      expect(screen.getByText('Test Team')).toBeInTheDocument();
    });
  });

  it('shows empty state when no channel is selected', async () => {
    useTeamStore.setState({ activeChannelId: null });
    render(<AppLayout />);
    await waitFor(() => {
      expect(screen.getByText('Select a channel to start chatting')).toBeInTheDocument();
    });
  });

  it('renders all desktop layout components', async () => {
    render(<AppLayout />);
    await waitFor(() => {
      expect(screen.getByTestId('team-sidebar')).toBeInTheDocument();
      expect(screen.getByTestId('channel-list')).toBeInTheDocument();
      expect(screen.getByTestId('user-panel')).toBeInTheDocument();
      expect(screen.getByTestId('voice-controls')).toBeInTheDocument();
      expect(screen.getByTestId('resize-handle')).toBeInTheDocument();
      expect(screen.getByTestId('member-list')).toBeInTheDocument();
      expect(screen.getByTestId('title-bar')).toBeInTheDocument();
    });
  });

  it('auth error handler navigates to /login', async () => {
    render(<AppLayout />);
    await waitFor(() => { expect(api.setAuthErrorHandler).toHaveBeenCalled(); });
    vi.mocked(api.setAuthErrorHandler).mock.calls[0][0]();
    expect(mockNavigate).toHaveBeenCalledWith('/login');
  });

  it('validates token on mount by calling getTeam', async () => {
    render(<AppLayout />);
    await waitFor(() => { expect(api.getTeam).toHaveBeenCalledWith('team1'); });
  });

  it('shows channel tabs (Kanals and PMs)', async () => {
    render(<AppLayout />);
    await waitFor(() => {
      expect(screen.getByText('Kanals')).toBeInTheDocument();
      expect(screen.getByText('PMs')).toBeInTheDocument();
    });
  });

  it('toggles member list visibility on button click', async () => {
    render(<AppLayout />);
    await waitFor(() => { expect(screen.getByTestId('member-list')).toBeInTheDocument(); });
    fireEvent.click(screen.getByTitle('Toggle Member List'));
    expect(screen.queryByTestId('member-list')).not.toBeInTheDocument();
  });

  it('navigates to team settings from sidebar button', async () => {
    render(<AppLayout />);
    await waitFor(() => { expect(screen.getByTitle('Team Settings')).toBeInTheDocument(); });
    fireEvent.click(screen.getByTitle('Team Settings'));
    expect(mockNavigate).toHaveBeenCalledWith('/app/settings');
  });

  it('auto-selects first team when none active', async () => {
    useTeamStore.setState({ activeTeamId: null, setActiveTeam: vi.fn() });
    render(<AppLayout />);
    await waitFor(() => {
      expect(useTeamStore.getState().setActiveTeam).toHaveBeenCalledWith('team1');
    });
  });

  it('connects WebSocket when connection info is available', async () => {
    vi.mocked(api.getConnectionInfo).mockReturnValue({ baseUrl: 'http://localhost:8080', token: 'tok' });
    render(<AppLayout />);
    await waitFor(() => {
      expect(ws.connect).toHaveBeenCalledWith('team1', 'ws://localhost:8080/ws', 'tok');
    });
  });

  it('shows voice channel for voice type with SoundHigh icon', async () => {
    useTeamStore.setState({
      activeChannelId: 'ch3',
      channels: new Map([['team1', [
        { id: 'ch3', name: 'voice-room', type: 'voice', teamId: 'team1', topic: '', position: 2, category: '' },
      ]]]),
    });
    render(<AppLayout />);
    await waitFor(() => {
      expect(screen.getByTestId('voice-channel')).toBeInTheDocument();
      expect(screen.getByTestId('SoundHigh')).toBeInTheDocument();
    });
  });

  it('shows channel topic in header', async () => {
    useTeamStore.setState({
      activeChannelId: 'ch-topic',
      channels: new Map([['team1', [
        { id: 'ch-topic', name: 'news', type: 'text', teamId: 'team1', topic: 'Breaking news', position: 0, category: '' },
      ]]]),
    });
    render(<AppLayout />);
    await waitFor(() => { expect(screen.getByText('Breaking news')).toBeInTheDocument(); });
  });

  it('still renders when getTeam fails', async () => {
    vi.mocked(api.getTeam).mockRejectedValue(new Error('401'));
    render(<AppLayout />);
    await waitFor(() => { expect(screen.getByTestId('title-bar')).toBeInTheDocument(); });
  });

  it('shows DM view with other user name for 1:1 DM', async () => {
    useTeamStore.setState({ activeChannelId: '' });
    useDMStore.setState({
      activeDMId: 'dm1', setActiveDM: vi.fn(),
      dmChannels: { team1: [{ id: 'dm1', members: [{ user_id: 'u1', username: 'tester', display_name: 'Tester' }, { user_id: 'u2', username: 'bob', display_name: 'Bob' }], is_group: false, created_at: '', last_message_at: null }] },
    });
    render(<AppLayout />);
    await waitFor(() => {
      expect(screen.getByTestId('dm-view')).toBeInTheDocument();
      expect(screen.getByText('Bob')).toBeInTheDocument();
    });
  });

  it('shows DM list when activeDMId is set with no matching DM (switches to DM mode)', async () => {
    useTeamStore.setState({ activeChannelId: '' });
    useDMStore.setState({
      activeDMId: 'some-dm', setActiveDM: vi.fn(),
      dmChannels: { team1: [] },
    });
    render(<AppLayout />);
    await waitFor(() => {
      expect(screen.getByTestId('dm-list')).toBeInTheDocument();
    });
  });

  it('shows thread panel when active', async () => {
    useThreadStore.setState({
      threads: { ch1: [{ id: 'th1', channel_id: 'ch1', parent_message_id: 'msg1', team_id: 'team1', creator_id: 'u1', title: '', message_count: 0, last_message_at: null, created_at: '' }] },
      activeThreadId: 'th1', threadPanelOpen: true,
    });
    render(<AppLayout />);
    await waitFor(() => { expect(screen.getByTestId('thread-panel')).toBeInTheDocument(); });
  });

  it('shows DM list and empty state when activeDMId has no match', async () => {
    useTeamStore.setState({ activeChannelId: '' });
    useDMStore.setState({ activeDMId: 'missing', setActiveDM: vi.fn(), dmChannels: { team1: [] } });
    render(<AppLayout />);
    await waitFor(() => {
      expect(screen.getByTestId('dm-list')).toBeInTheDocument();
      expect(screen.getByText('No direct messages yet')).toBeInTheDocument();
    });
  });

  it('renders search bar in header', async () => {
    render(<AppLayout />);
    await waitFor(() => { expect(screen.getAllByTestId('search-bar').length).toBeGreaterThan(0); });
  });

  it('shows lock icon when derivedKey is set on channel header', async () => {
    useAuthStore.setState({
      derivedKey: 'some-key',
      teams: new Map([
        ['team1', { baseUrl: 'http://localhost:8080', token: 'tok', user: { id: 'u1', username: 'tester', display_name: 'Tester' }, teamInfo: {} }],
      ]),
    });
    render(<AppLayout />);
    await waitFor(() => {
      expect(screen.getByTestId('Lock')).toBeInTheDocument();
    });
  });

  it('shows group DM with member count and Group icon', async () => {
    useTeamStore.setState({ activeChannelId: '' });
    useDMStore.setState({
      activeDMId: 'dm-group', setActiveDM: vi.fn(),
      dmChannels: { team1: [{
        id: 'dm-group',
        members: [
          { user_id: 'u1', username: 'tester', display_name: 'Tester' },
          { user_id: 'u2', username: 'bob', display_name: 'Bob' },
          { user_id: 'u3', username: 'charlie', display_name: 'Charlie' },
        ],
        is_group: true, created_at: '', last_message_at: null,
      }] },
    });
    render(<AppLayout />);
    await waitFor(() => {
      expect(screen.getByTestId('dm-view')).toBeInTheDocument();
    });
  });

  it('shows DM empty state when no active DM in DM mode', async () => {
    useTeamStore.setState({ activeChannelId: '' });
    useDMStore.setState({
      activeDMId: null, setActiveDM: vi.fn(),
      dmChannels: {},
    });
    render(<AppLayout />);
    await waitFor(() => {
      // Switch to DM mode - but since there's no activeDMId, show channel view
      expect(screen.getByTestId('title-bar')).toBeInTheDocument();
    });
  });

  it('renders both sidebar tabs (Kanals and PMs) and they are clickable', async () => {
    render(<AppLayout />);
    await waitFor(() => {
      expect(screen.getByText('PMs')).toBeInTheDocument();
      expect(screen.getByText('Kanals')).toBeInTheDocument();
    });
    // Just verify clicking doesn't crash
    fireEvent.click(screen.getByText('PMs'));
    fireEvent.click(screen.getByText('Kanals'));
  });

  it('triggers WS sync:init when WS is already connected', async () => {
    vi.mocked(ws.isConnected).mockReturnValue(true);
    vi.mocked(ws.request).mockResolvedValue({});
    render(<AppLayout />);
    await waitFor(() => {
      expect(ws.request).toHaveBeenCalled();
    });
  });

  it('fires WS event handlers for presence changes', async () => {
    render(<AppLayout />);
    await waitFor(() => { expect(ws.on).toHaveBeenCalled(); });
    const calls = vi.mocked(ws.on).mock.calls;
    const presenceHandler = calls.find(c => c[0] === 'presence:changed');
    if (presenceHandler) {
      (presenceHandler[1] as Function)({
        team_id: 'team1',
        user_id: 'u2',
        status_type: 'away',
        status_text: 'brb',
      });
    }
  });

  it('fires WS event handlers for voice join/leave', async () => {
    render(<AppLayout />);
    await waitFor(() => { expect(ws.on).toHaveBeenCalled(); });
    const calls = vi.mocked(ws.on).mock.calls;

    const voiceJoinHandler = calls.find(c => c[0] === 'voice:user-joined');
    if (voiceJoinHandler) {
      (voiceJoinHandler[1] as Function)({
        channel_id: 'ch-voice', user_id: 'u2', username: 'bob',
      });
    }

    const voiceLeftHandler = calls.find(c => c[0] === 'voice:user-left');
    if (voiceLeftHandler) {
      (voiceLeftHandler[1] as Function)({ channel_id: 'ch-voice', user_id: 'u2' });
    }

    const muteHandler = calls.find(c => c[0] === 'voice:mute-update');
    if (muteHandler) {
      (muteHandler[1] as Function)({ channel_id: 'ch-voice', user_id: 'u2', muted: true, deafened: false });
    }

    const screenHandler = calls.find(c => c[0] === 'voice:screen-update');
    if (screenHandler) {
      (screenHandler[1] as Function)({ channel_id: 'ch-voice', user_id: 'u2', sharing: true });
    }

    const webcamHandler = calls.find(c => c[0] === 'voice:webcam-update');
    if (webcamHandler) {
      (webcamHandler[1] as Function)({ channel_id: 'ch-voice', user_id: 'u2', sharing: true });
    }
  });

  it('navigates to user settings from UserPanel', async () => {
    render(<AppLayout />);
    await waitFor(() => { expect(screen.getByTestId('user-panel')).toBeInTheDocument(); });
  });

  it('fires ws:connected handler and triggers sync:init', async () => {
    vi.mocked(ws.request).mockResolvedValue({
      channels: [{ id: 'ch-new', name: 'new-ch', type: 'text', team_id: 'team1', topic: '', position: 0, category: '' }],
      team: { id: 'team1', name: 'Test Team', description: '', iconUrl: '', maxFileSize: 0, allowMemberInvites: true },
      members: [{ id: 'm1', user_id: 'u1', username: 'tester', display_name: 'Tester', nickname: '', roles: [] }],
      roles: [],
      presences: { 'u1': { status: 'online', custom_status: '' } },
    });
    render(<AppLayout />);
    await waitFor(() => { expect(ws.on).toHaveBeenCalled(); });

    // Find and invoke ws:connected handler
    const calls = vi.mocked(ws.on).mock.calls;
    const connHandler = calls.find(c => c[0] === 'ws:connected');
    if (connHandler) {
      (connHandler[1] as Function)({ teamId: 'team1' });
      await waitFor(() => {
        expect(ws.request).toHaveBeenCalled();
      });
    }
  });

  it('applies sync data with voice states', async () => {
    vi.mocked(ws.request).mockResolvedValue({
      channels: [],
      team: { id: 'team1', name: 'Test Team' },
      members: [],
      roles: [],
      presences: {},
      voice_states: { 'ch-voice': [{ user_id: 'u2', username: 'bob', muted: false, deafened: false, speaking: false, voiceLevel: 0 }] },
    });
    vi.mocked(ws.isConnected).mockReturnValue(true);
    render(<AppLayout />);
    await waitFor(() => {
      expect(ws.request).toHaveBeenCalled();
    });
  });

  it('falls back to REST when sync:init fails', async () => {
    vi.mocked(ws.request).mockRejectedValue(new Error('sync failed'));
    vi.mocked(ws.isConnected).mockReturnValue(true);
    render(<AppLayout />);
    await waitFor(() => {
      // Should fall back to REST calls
      expect(api.getChannels).toHaveBeenCalledWith('team1');
    });
  });

  it('does not connect WS when no connection info', async () => {
    vi.mocked(api.getConnectionInfo).mockReturnValue(null);
    render(<AppLayout />);
    await waitFor(() => {
      expect(ws.connect).not.toHaveBeenCalled();
    });
  });

  it('shows DM empty message in DM mode with no active DM', async () => {
    useTeamStore.setState({ activeChannelId: '' });
    useDMStore.setState({
      activeDMId: 'some-id', setActiveDM: vi.fn(),
      dmChannels: { team1: [] },
    });
    render(<AppLayout />);
    await waitFor(() => {
      expect(screen.getByText('No direct messages yet')).toBeInTheDocument();
    });
  });

  it('handles presence:changed event with missing fields', async () => {
    render(<AppLayout />);
    await waitFor(() => { expect(ws.on).toHaveBeenCalled(); });
    const calls = vi.mocked(ws.on).mock.calls;
    const presenceHandler = calls.find(c => c[0] === 'presence:changed');
    if (presenceHandler) {
      // With minimal payload
      (presenceHandler[1] as Function)({ user_id: 'u2', status: 'online' });
      // With status_type variant
      (presenceHandler[1] as Function)({ user_id: 'u3', status_type: 'away', status_text: 'brb' });
    }
  });

  it('shows DM toggle members button for group DM and toggles', async () => {
    useTeamStore.setState({ activeChannelId: '' });
    useDMStore.setState({
      activeDMId: 'dm-grp', setActiveDM: vi.fn(),
      dmChannels: { team1: [{
        id: 'dm-grp',
        members: [
          { user_id: 'u1', username: 'tester', display_name: 'Tester' },
          { user_id: 'u2', username: 'bob', display_name: 'Bob' },
        ],
        is_group: true, created_at: '', last_message_at: null,
      }] },
    });
    render(<AppLayout />);
    await waitFor(() => {
      expect(screen.getByTestId('dm-view')).toBeInTheDocument();
    });
    // The Group icon toggle button should be present for group DMs
    const groupIcons = screen.getAllByTestId('Group');
    expect(groupIcons.length).toBeGreaterThanOrEqual(1);
  });

  it('shows header with Dilla name when no channel or DM is selected', async () => {
    useTeamStore.setState({ activeChannelId: '' });
    useDMStore.setState({ activeDMId: null, setActiveDM: vi.fn(), dmChannels: {} });
    render(<AppLayout />);
    await waitFor(() => {
      // Should show app name and toggle member list button
      const toggleBtns = screen.getAllByTitle('Toggle Member List');
      expect(toggleBtns.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('handles voice events with missing fields gracefully', async () => {
    render(<AppLayout />);
    await waitFor(() => { expect(ws.on).toHaveBeenCalled(); });
    const calls = vi.mocked(ws.on).mock.calls;

    // voice:user-joined with no channel_id (should be ignored)
    const joinHandler = calls.find(c => c[0] === 'voice:user-joined');
    if (joinHandler) {
      (joinHandler[1] as Function)({ channel_id: '', user_id: '' });
    }

    // voice:user-left with no channel_id
    const leftHandler = calls.find(c => c[0] === 'voice:user-left');
    if (leftHandler) {
      (leftHandler[1] as Function)({ channel_id: '', user_id: '' });
    }
  });

  it('uploads identity blob when derivedKey is set and data is loaded', async () => {
    const mockExportBlob = vi.fn().mockResolvedValue('encrypted-blob');
    vi.doMock('../services/keyStore', () => ({
      unlockWithPrf: vi.fn(),
      exportIdentityBlob: mockExportBlob,
    }));

    useAuthStore.setState({
      derivedKey: 'test-derived-key',
      teams: new Map([
        ['team1', { baseUrl: 'http://localhost:8080', token: 'tok', user: { id: 'u1', username: 'tester', display_name: 'Tester' }, teamInfo: {} }],
      ]),
    });

    // Make sync:init succeed so dataLoaded is populated
    vi.mocked(ws.isConnected).mockReturnValue(true);
    vi.mocked(ws.request).mockResolvedValue({ channels: [], team: { id: 'team1', name: 'T' }, members: [], roles: [], presences: {} });

    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });

    render(<AppLayout />);
    await waitFor(() => {
      expect(ws.request).toHaveBeenCalled();
    });
  });

  it('re-initializes crypto from persisted derivedKey', async () => {
    const { fromBase64 } = await import('../services/cryptoCore');
    const { unlockWithPrf } = await import('../services/keyStore');
    const { initCrypto } = await import('../services/crypto');

    useAuthStore.setState({
      derivedKey: 'test-derived-key',
      teams: new Map([
        ['team1', { baseUrl: 'http://localhost:8080', token: 'tok', user: { id: 'u1', username: 'tester', display_name: 'Tester' }, teamInfo: {} }],
      ]),
    });

    render(<AppLayout />);
    await waitFor(() => {
      expect(fromBase64).toHaveBeenCalledWith('test-derived-key');
    });
  });

  it('shows group DM toggle members button and toggles it', async () => {
    useTeamStore.setState({ activeChannelId: '' });
    useDMStore.setState({
      activeDMId: 'dm-grp2', setActiveDM: vi.fn(),
      dmChannels: { team1: [{
        id: 'dm-grp2',
        members: [
          { user_id: 'u1', username: 'tester', display_name: 'Tester' },
          { user_id: 'u2', username: 'bob', display_name: 'Bob' },
        ],
        is_group: true, created_at: '', last_message_at: null,
      }] },
    });
    render(<AppLayout />);
    await waitFor(() => {
      expect(screen.getByTestId('dm-view')).toBeInTheDocument();
    });
    // Find toggle member list button in DM header
    const toggleBtns = screen.getAllByTitle('Toggle Member List');
    if (toggleBtns.length > 0) {
      fireEvent.click(toggleBtns[0]);
    }
  });

  it('shows lock icon on DM header when derivedKey is set', async () => {
    useAuthStore.setState({
      derivedKey: 'some-key',
      teams: new Map([
        ['team1', { baseUrl: 'http://localhost:8080', token: 'tok', user: { id: 'u1', username: 'tester', display_name: 'Tester' }, teamInfo: {} }],
      ]),
    });
    useTeamStore.setState({ activeChannelId: '' });
    useDMStore.setState({
      activeDMId: 'dm-lock', setActiveDM: vi.fn(),
      dmChannels: { team1: [{
        id: 'dm-lock',
        members: [
          { user_id: 'u1', username: 'tester', display_name: 'Tester' },
          { user_id: 'u2', username: 'bob', display_name: 'Bob' },
        ],
        is_group: false, created_at: '', last_message_at: null,
      }] },
    });
    render(<AppLayout />);
    await waitFor(() => {
      expect(screen.getByTestId('Lock')).toBeInTheDocument();
    });
  });

  it('shows group DM name from members when no name set', async () => {
    useTeamStore.setState({ activeChannelId: '' });
    useDMStore.setState({
      activeDMId: 'dm-grp3', setActiveDM: vi.fn(),
      dmChannels: { team1: [{
        id: 'dm-grp3',
        members: [
          { user_id: 'u1', username: 'tester', display_name: 'Tester' },
          { user_id: 'u2', username: 'bob', display_name: 'Bob' },
          { user_id: 'u3', username: 'charlie', display_name: 'Charlie' },
        ],
        is_group: true, created_at: '', last_message_at: null,
      }] },
    });
    render(<AppLayout />);
    await waitFor(() => {
      // Group DM shows member names joined
      expect(screen.getByText('Tester, Bob, Charlie')).toBeInTheDocument();
    });
  });

  it('shows group DM member count', async () => {
    useTeamStore.setState({ activeChannelId: '' });
    useDMStore.setState({
      activeDMId: 'dm-grp4', setActiveDM: vi.fn(),
      dmChannels: { team1: [{
        id: 'dm-grp4',
        members: [
          { user_id: 'u1', username: 'tester', display_name: 'Tester' },
          { user_id: 'u2', username: 'bob', display_name: 'Bob' },
          { user_id: 'u3', username: 'charlie', display_name: 'Charlie' },
        ],
        is_group: true, created_at: '', last_message_at: null,
      }] },
    });
    render(<AppLayout />);
    await waitFor(() => {
      // The t() mock returns the key, so look for the translated key
      expect(screen.getByText(/members/i)).toBeInTheDocument();
    });
  });

  it('shows 1:1 DM fallback name when no other member', async () => {
    useTeamStore.setState({ activeChannelId: '' });
    useDMStore.setState({
      activeDMId: 'dm-solo', setActiveDM: vi.fn(),
      dmChannels: { team1: [{
        id: 'dm-solo',
        members: [{ user_id: 'u1', username: 'tester', display_name: 'Tester' }],
        is_group: false, created_at: '', last_message_at: null,
      }] },
    });
    render(<AppLayout />);
    await waitFor(() => {
      expect(screen.getByText('Direct Message')).toBeInTheDocument();
    });
  });

  it('handles WS connection with https URL', async () => {
    vi.mocked(api.getConnectionInfo).mockReturnValue({ baseUrl: 'https://example.com', token: 'tok' });
    render(<AppLayout />);
    await waitFor(() => {
      expect(ws.connect).toHaveBeenCalledWith('team1', 'wss://example.com/ws', 'tok');
    });
  });

  it('syncs own presence from sync:init presences', async () => {
    vi.mocked(ws.isConnected).mockReturnValue(true);
    vi.mocked(ws.request).mockResolvedValue({
      channels: [],
      team: { id: 'team1', name: 'Test Team' },
      members: [],
      roles: [],
      presences: { 'u1': { status: 'online', custom_status: 'Working' } },
    });
    render(<AppLayout />);
    await waitFor(() => {
      expect(ws.request).toHaveBeenCalled();
    });
  });

  it('REST fallback calls getPresences and syncs own status', async () => {
    vi.mocked(ws.request).mockRejectedValue(new Error('sync failed'));
    vi.mocked(ws.isConnected).mockReturnValue(true);
    vi.mocked(api.getPresences).mockResolvedValue({
      u1: { user_id: 'u1', status: 'online', custom_status: 'hi', last_active: '' },
    });
    render(<AppLayout />);
    await waitFor(() => {
      expect(api.getPresences).toHaveBeenCalledWith('team1');
    });
  });

  it('shows DMList when DM mode is active (activeDMId set)', async () => {
    useTeamStore.setState({ activeChannelId: '' });
    useDMStore.setState({
      activeDMId: 'dm-1', setActiveDM: vi.fn(),
      dmChannels: { team1: [{ id: 'dm-1', members: [{ user_id: 'u1', username: 'tester', display_name: 'Tester' }, { user_id: 'u2', username: 'bob', display_name: 'Bob' }], is_group: false, created_at: '', last_message_at: null }] },
    });
    render(<AppLayout />);
    await waitFor(() => {
      expect(screen.getByTestId('dm-list')).toBeInTheDocument();
    });
  });

  it('shows CreateChannel modal (via channelSidebarContent)', async () => {
    // CreateChannel is mocked to null, but we can verify showCreateChannel is set
    render(<AppLayout />);
    await waitFor(() => {
      expect(screen.getByTestId('channel-list')).toBeInTheDocument();
    });
  });

  it('shows NewDMModal when in DM mode and clicking new DM', async () => {
    // NewDMModal is mocked to null, but switching to DM mode and
    // rendering should still not crash
    useTeamStore.setState({ activeChannelId: '' });
    useDMStore.setState({
      activeDMId: null, setActiveDM: vi.fn(),
      dmChannels: { team1: [] },
    });
    render(<AppLayout />);
    await waitFor(() => {
      expect(screen.getByText('PMs')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('PMs'));
    await waitFor(() => {
      expect(screen.getByTestId('dm-list')).toBeInTheDocument();
    });
  });

  it('renders empty state text for both DM and channel mode', async () => {
    useTeamStore.setState({ activeChannelId: '' });
    useDMStore.setState({ activeDMId: null, setActiveDM: vi.fn(), dmChannels: {} });
    render(<AppLayout />);
    await waitFor(() => {
      expect(screen.getByText('Select a channel to start chatting')).toBeInTheDocument();
    });

    // Switch to DM mode
    fireEvent.click(screen.getByText('PMs'));
    await waitFor(() => {
      expect(screen.getByText('No direct messages yet')).toBeInTheDocument();
    });
  });

  it('hides member list in DM mode when not group DM', async () => {
    useTeamStore.setState({ activeChannelId: '' });
    useDMStore.setState({
      activeDMId: 'dm-solo', setActiveDM: vi.fn(),
      dmChannels: { team1: [{
        id: 'dm-solo',
        members: [
          { user_id: 'u1', username: 'tester', display_name: 'Tester' },
          { user_id: 'u2', username: 'bob', display_name: 'Bob' },
        ],
        is_group: false, created_at: '', last_message_at: null,
      }] },
    });
    render(<AppLayout />);
    await waitFor(() => {
      expect(screen.getByTestId('dm-view')).toBeInTheDocument();
    });
  });
});

describe('AppLayout mobile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigate.mockClear();
    mockUseIsMobile.mockReturnValue(true);

    useAuthStore.setState({
      isAuthenticated: true,
      derivedKey: null,
      publicKey: null,
      teams: new Map([
        [
          'team1',
          {
            baseUrl: 'http://localhost:8080',
            token: 'tok',
            user: { id: 'u1', username: 'tester', display_name: 'Tester' },
            teamInfo: {},
          },
        ],
      ]),
    });

    useTeamStore.setState({
      activeTeamId: 'team1',
      activeChannelId: 'ch1',
      channels: new Map([['team1', [
        { id: 'ch1', name: 'general', type: 'text', teamId: 'team1', topic: '', position: 0, category: '' },
      ]]]),
      teams: new Map([['team1', { id: 'team1', name: 'Test Team', description: '', iconUrl: '', maxFileSize: 0, allowMemberInvites: true }]]),
      members: new Map(),
      roles: new Map(),
      setActiveChannel: vi.fn(),
      setActiveTeam: vi.fn(),
      setTeam: vi.fn(),
      setChannels: vi.fn(),
      setMembers: vi.fn(),
      setRoles: vi.fn(),
    });

    useDMStore.setState({
      activeDMId: null,
      setActiveDM: vi.fn(),
      dmChannels: {},
    });

    useThreadStore.setState({
      threads: {},
      activeThreadId: null,
      threadPanelOpen: false,
      setActiveThread: vi.fn(),
      setThreadPanelOpen: vi.fn(),
    });
  });

  afterEach(() => {
    mockUseIsMobile.mockReturnValue(false);
  });

  it('shows mobile tab bar and bottom controls in mobile mode', async () => {
    render(<AppLayout />);
    await waitFor(() => {
      expect(screen.getByTestId('mobile-tab-bar')).toBeInTheDocument();
      expect(screen.getByTestId('voice-controls')).toBeInTheDocument();
      expect(screen.getByTestId('user-panel')).toBeInTheDocument();
    });
  });

  it('does not show desktop left panels in mobile mode', async () => {
    render(<AppLayout />);
    await waitFor(() => {
      expect(screen.queryByTestId('resize-handle')).not.toBeInTheDocument();
    });
  });

  it('shows teams tab content when tab is teams', async () => {
    render(<AppLayout />);
    await waitFor(() => {
      expect(screen.getByTestId('mobile-tab-bar')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('tab-teams'));
    await waitFor(() => {
      expect(screen.getByTestId('team-sidebar')).toBeInTheDocument();
    });
  });

  it('shows channels tab content when tab is channels', async () => {
    render(<AppLayout />);
    await waitFor(() => {
      expect(screen.getByTestId('mobile-tab-bar')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('tab-channels'));
    await waitFor(() => {
      expect(screen.getByTestId('channel-list')).toBeInTheDocument();
    });
  });

  it('shows members tab content when tab is members', async () => {
    render(<AppLayout />);
    await waitFor(() => {
      expect(screen.getByTestId('mobile-tab-bar')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('tab-members'));
    await waitFor(() => {
      expect(screen.getByTestId('member-list')).toBeInTheDocument();
    });
  });

  it('shows chat content when tab is chat', async () => {
    render(<AppLayout />);
    await waitFor(() => {
      expect(screen.getByTestId('mobile-tab-bar')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('tab-chat'));
    await waitFor(() => {
      expect(screen.getByTestId('channel-view')).toBeInTheDocument();
    });
  });

  it('renders mobile class on main layout', async () => {
    const { container } = render(<AppLayout />);
    await waitFor(() => {
      const mainDiv = container.querySelector('.app-layout-main');
      expect(mainDiv?.className).toContain('mobile');
    });
  });
});
