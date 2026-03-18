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

vi.mock('../components/MobileTabBar/MobileTabBar', () => ({ default: () => null }));
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
});
