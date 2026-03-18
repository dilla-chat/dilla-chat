import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

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

vi.mock('../components/MobileTabBar/MobileTabBar', () => ({
  default: () => null,
}));

vi.mock('../components/TeamSidebar/TeamSidebar', () => ({
  default: () => <div data-testid="team-sidebar">TeamSidebar</div>,
}));

vi.mock('../components/ChannelList/ChannelList', () => ({
  default: () => <div data-testid="channel-list">ChannelList</div>,
}));

vi.mock('../components/DMList/DMList', () => ({
  default: () => <div data-testid="dm-list">DMList</div>,
}));

vi.mock('../components/DMList/NewDMModal', () => ({
  default: () => null,
}));

vi.mock('../components/DMView/DMView', () => ({
  default: () => <div data-testid="dm-view">DMView</div>,
}));

vi.mock('../components/VoiceControls/VoiceControls', () => ({
  default: () => <div data-testid="voice-controls">VoiceControls</div>,
}));

vi.mock('../components/VoiceChannel/VoiceChannel', () => ({
  default: () => null,
}));

vi.mock('../components/UserPanel/UserPanel', () => ({
  default: () => <div data-testid="user-panel">UserPanel</div>,
}));

vi.mock('../components/MemberList/MemberList', () => ({
  default: () => <div data-testid="member-list">MemberList</div>,
}));

vi.mock('../components/CreateChannel/CreateChannel', () => ({
  default: () => null,
}));

vi.mock('../components/ThreadPanel/ThreadPanel', () => ({
  default: () => null,
}));

vi.mock('../components/SearchBar/SearchBar', () => ({
  default: () => <div data-testid="search-bar">SearchBar</div>,
}));

vi.mock('../components/ShortcutsModal/ShortcutsModal', () => ({
  default: () => null,
}));

vi.mock('../components/ResizeHandle/ResizeHandle', () => ({
  default: () => <div data-testid="resize-handle">ResizeHandle</div>,
}));

vi.mock('../components/TitleBar/TitleBar', () => ({
  default: () => <div data-testid="title-bar">TitleBar</div>,
}));

vi.mock('./ChannelView', () => ({
  default: () => <div data-testid="channel-view">ChannelView</div>,
}));

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
      channels: new Map([['team1', [{ id: 'ch1', name: 'general', type: 'text', teamId: 'team1', topic: '', position: 0, category: '' }]]]),
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
  });

  it('registers WS event handlers for presence and voice', async () => {
    render(<AppLayout />);

    await waitFor(() => {
      expect(ws.on).toHaveBeenCalled();
    });

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

    await waitFor(() => {
      expect(api.setAuthErrorHandler).toHaveBeenCalled();
    });
  });

  it('restores API connections from persisted teams on mount', async () => {
    render(<AppLayout />);

    await waitFor(() => {
      expect(api.addTeam).toHaveBeenCalledWith('team1', 'http://localhost:8080');
      expect(api.setToken).toHaveBeenCalledWith('team1', 'tok');
    });
  });

  it('redirects to /join when no teams', async () => {
    useAuthStore.setState({
      teams: new Map(),
    });

    render(<AppLayout />);

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/join');
    });
  });

  it('shows onboarding UI when no teams', async () => {
    useAuthStore.setState({
      teams: new Map(),
    });

    render(<AppLayout />);

    await waitFor(() => {
      expect(screen.getByText('Join a Server')).toBeInTheDocument();
      expect(screen.getByText('Set Up a Server')).toBeInTheDocument();
    });
  });

  it('renders channel view for active text channel', async () => {
    render(<AppLayout />);

    await waitFor(() => {
      expect(screen.getByTestId('channel-view')).toBeInTheDocument();
    });
  });

  it('shows channel name in header', async () => {
    render(<AppLayout />);

    await waitFor(() => {
      expect(screen.getByText('general')).toBeInTheDocument();
    });
  });

  it('shows empty state when no channel is selected', async () => {
    useTeamStore.setState({
      activeChannelId: null,
    });

    render(<AppLayout />);

    await waitFor(() => {
      expect(
        screen.getByText('Select a channel to start chatting'),
      ).toBeInTheDocument();
    });
  });

  it('renders team sidebar on desktop', async () => {
    render(<AppLayout />);

    await waitFor(() => {
      expect(screen.getByTestId('team-sidebar')).toBeInTheDocument();
    });
  });

  it('renders channel list on desktop', async () => {
    render(<AppLayout />);

    await waitFor(() => {
      expect(screen.getByTestId('channel-list')).toBeInTheDocument();
    });
  });

  it('renders user panel on desktop', async () => {
    render(<AppLayout />);

    await waitFor(() => {
      expect(screen.getByTestId('user-panel')).toBeInTheDocument();
    });
  });

  it('renders voice controls on desktop', async () => {
    render(<AppLayout />);

    await waitFor(() => {
      expect(screen.getByTestId('voice-controls')).toBeInTheDocument();
    });
  });

  it('auth error handler navigates to /login', async () => {
    render(<AppLayout />);

    await waitFor(() => {
      expect(api.setAuthErrorHandler).toHaveBeenCalled();
    });

    const handler = vi.mocked(api.setAuthErrorHandler).mock.calls[0][0];
    handler();

    expect(mockNavigate).toHaveBeenCalledWith('/login');
  });

  it('validates token on mount by calling getTeam', async () => {
    render(<AppLayout />);

    await waitFor(() => {
      expect(api.getTeam).toHaveBeenCalledWith('team1');
    });
  });

  it('renders TitleBar', async () => {
    render(<AppLayout />);

    await waitFor(() => {
      expect(screen.getByTestId('title-bar')).toBeInTheDocument();
    });
  });

  it('shows channel tabs (Kanals and PMs)', async () => {
    render(<AppLayout />);

    await waitFor(() => {
      expect(screen.getByText('Kanals')).toBeInTheDocument();
      expect(screen.getByText('PMs')).toBeInTheDocument();
    });
  });
});
