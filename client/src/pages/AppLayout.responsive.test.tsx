import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mock heavy dependencies before importing AppLayout
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
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: '/app' }),
}));

const mockTeamMap = new Map([
  [
    'team1',
    {
      baseUrl: 'http://localhost:8080',
      token: 'tok',
      user: { id: 'u1', username: 'tester' },
    },
  ],
]);

vi.mock('../stores/authStore', () => ({
  useAuthStore: () => ({
    teams: mockTeamMap,
    derivedKey: null,
  }),
  restoreDerivedKey: vi.fn().mockResolvedValue(null),
}));

vi.mock('../stores/teamStore', () => ({
  useTeamStore: () => ({
    activeTeamId: 'team1',
    activeChannelId: 'ch1',
    channels: new Map([['team1', [{ id: 'ch1', name: 'general', type: 'text' }]]]),
    setActiveChannel: vi.fn(),
    setActiveTeam: vi.fn(),
    teams: new Map([['team1', { id: 'team1', name: 'Test Team' }]]),
    setTeam: vi.fn(),
    setChannels: vi.fn(),
    setMembers: vi.fn(),
    setRoles: vi.fn(),
  }),
}));

vi.mock('../stores/dmStore', () => ({
  useDMStore: () => ({
    activeDMId: null,
    setActiveDM: vi.fn(),
    dmChannels: {},
  }),
}));

vi.mock('../stores/threadStore', () => ({
  useThreadStore: () => ({
    activeThreadId: null,
    threadPanelOpen: false,
    threads: {},
    setActiveThread: vi.fn(),
    setThreadPanelOpen: vi.fn(),
  }),
}));

vi.mock('../stores/presenceStore', () => ({
  usePresenceStore: () => ({
    setPresences: vi.fn(),
    updatePresence: vi.fn(),
    setMyStatus: vi.fn(),
    setMyCustomStatus: vi.fn(),
  }),
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
  default: () => <div>SearchBar</div>,
}));

vi.mock('../components/ShortcutsModal/ShortcutsModal', () => ({
  default: () => null,
}));

vi.mock('../components/ResizeHandle/ResizeHandle', () => ({
  default: () => <div data-testid="resize-handle">ResizeHandle</div>,
}));

vi.mock('../components/TitleBar/TitleBar', () => ({
  default: () => <div>TitleBar</div>,
}));

vi.mock('./ChannelView', () => ({
  default: () => <div data-testid="channel-view">ChannelView</div>,
}));

import AppLayout from './AppLayout';

function setMobile(isMobile: boolean) {
  vi.mocked(globalThis.matchMedia).mockImplementation((query: string) => ({
    matches: isMobile && query === '(max-width: 767px)',
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

describe('AppLayout responsive', () => {
  beforeEach(() => {
    setMobile(false);
  });

  it('renders left-panels and resize-handle on desktop', async () => {
    render(<AppLayout />);
    expect(await screen.findByTestId('resize-handle')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).not.toBeInTheDocument();
  });

  it('renders MobileTabBar when mobile', async () => {
    setMobile(true);
    render(<AppLayout />);
    expect(await screen.findByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
    expect(screen.queryByTestId('resize-handle')).not.toBeInTheDocument();
  });

  it('shows channel view (chat tab) by default on mobile', async () => {
    setMobile(true);
    render(<AppLayout />);
    expect(await screen.findByTestId('channel-view')).toBeInTheDocument();
  });

  it('switches to teams tab on mobile', async () => {
    setMobile(true);
    render(<AppLayout />);
    await screen.findByRole('navigation', { name: 'Main navigation' });
    const teamsTab = screen.getByText('Teams').closest('button')!;
    await userEvent.click(teamsTab);
    await waitFor(() => {
      expect(screen.getByTestId('team-sidebar')).toBeInTheDocument();
      expect(screen.queryByTestId('channel-view')).not.toBeInTheDocument();
    });
  });

  it('switches to members tab on mobile', async () => {
    setMobile(true);
    render(<AppLayout />);
    await screen.findByRole('navigation', { name: 'Main navigation' });
    const membersTab = screen.getByText('Members').closest('button')!;
    await userEvent.click(membersTab);
    await waitFor(() => {
      expect(screen.getByTestId('member-list')).toBeInTheDocument();
    });
  });
});
