import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TeamSidebar from './TeamSidebar';
import { useAuthStore } from '../../stores/authStore';
import { useTeamStore } from '../../stores/teamStore';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('@tabler/icons-react', () => ({
  IconPlus: () => <span data-testid="Plus" />,
}));

describe('TeamSidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    const teams = new Map([
      ['team-1', { token: 't1', user: {}, teamInfo: { name: 'Alpha' }, baseUrl: 'https://a.example.com', serverId: 'a.example.com' }],
      ['team-2', { token: 't2', user: {}, teamInfo: { name: 'Beta' }, baseUrl: 'https://a.example.com', serverId: 'a.example.com' }],
    ]);
    const servers = new Map([
      ['a.example.com', { baseUrl: 'https://a.example.com', token: 't1', username: 'alice', teamIds: ['team-1', 'team-2'] }],
    ]);
    useAuthStore.setState({ teams, servers });

    const teamMap = new Map([
      ['team-1', { id: 'team-1', name: 'Alpha', description: '', iconUrl: '', maxFileSize: 0, allowMemberInvites: false }],
      ['team-2', { id: 'team-2', name: 'Beta', description: '', iconUrl: '', maxFileSize: 0, allowMemberInvites: false }],
    ]);
    useTeamStore.setState({ activeTeamId: 'team-1', teams: teamMap });
  });

  it('renders team icons', () => {
    render(<TeamSidebar />);
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('B')).toBeInTheDocument();
  });

  it('marks the active team', () => {
    const { container } = render(<TeamSidebar />);
    const activeIcons = container.querySelectorAll('.team-icon.active');
    expect(activeIcons.length).toBe(1);
    expect(activeIcons[0].textContent).toBe('A');
  });

  it('switches team on click', () => {
    render(<TeamSidebar />);
    fireEvent.click(screen.getByText('B'));
    expect(useTeamStore.getState().activeTeamId).toBe('team-2');
  });

  it('navigates to /join when add button is clicked', () => {
    render(<TeamSidebar />);
    const addBtn = screen.getByTestId('Plus').closest('button')!;
    fireEvent.click(addBtn);
    expect(mockNavigate).toHaveBeenCalledWith('/join');
  });

  it('renders add team button', () => {
    const { container } = render(<TeamSidebar />);
    expect(container.querySelector('.team-add')).toBeInTheDocument();
  });

  it('renders separator between teams and add button', () => {
    const { container } = render(<TeamSidebar />);
    expect(container.querySelector('.team-separator')).toBeInTheDocument();
  });

  it('renders server labels and separators for multiple servers', () => {
    const teams = new Map([
      ['team-1', { token: 't1', user: {}, teamInfo: { name: 'Alpha' }, baseUrl: 'https://a.example.com', serverId: 'a.example.com' }],
      ['team-2', { token: 't2', user: {}, teamInfo: { name: 'Beta' }, baseUrl: 'https://b.example.com', serverId: 'b.example.com' }],
    ]);
    const servers = new Map([
      ['a.example.com', { baseUrl: 'https://a.example.com', token: 't1', username: 'alice', teamIds: ['team-1'] }],
      ['b.example.com', { baseUrl: 'https://b.example.com', token: 't2', username: 'alice', teamIds: ['team-2'] }],
    ]);
    useAuthStore.setState({ teams, servers });

    const teamMap = new Map([
      ['team-1', { id: 'team-1', name: 'Alpha', description: '', iconUrl: '', maxFileSize: 0, allowMemberInvites: false }],
      ['team-2', { id: 'team-2', name: 'Beta', description: '', iconUrl: '', maxFileSize: 0, allowMemberInvites: false }],
    ]);
    useTeamStore.setState({ activeTeamId: 'team-1', teams: teamMap });

    const { container } = render(<TeamSidebar />);
    // Should show server labels since multiple servers
    const labels = container.querySelectorAll('.server-label');
    expect(labels.length).toBe(2);
    // Should show separator between server groups
    expect(container.querySelector('.team-separator')).toBeInTheDocument();
  });

  it('renders ungrouped teams separately', () => {
    const teams = new Map([
      ['team-1', { token: 't1', user: {}, teamInfo: { name: 'Alpha' }, baseUrl: 'https://a.example.com', serverId: 'a.example.com' }],
      ['team-3', { token: 't3', user: {}, teamInfo: { name: 'Gamma' }, baseUrl: 'https://c.example.com', serverId: '' }],
    ]);
    const servers = new Map([
      ['a.example.com', { baseUrl: 'https://a.example.com', token: 't1', username: 'alice', teamIds: ['team-1'] }],
    ]);
    useAuthStore.setState({ teams, servers });

    const teamMap = new Map([
      ['team-1', { id: 'team-1', name: 'Alpha', description: '', iconUrl: '', maxFileSize: 0, allowMemberInvites: false }],
      ['team-3', { id: 'team-3', name: 'Gamma', description: '', iconUrl: '', maxFileSize: 0, allowMemberInvites: false }],
    ]);
    useTeamStore.setState({ activeTeamId: 'team-1', teams: teamMap });

    render(<TeamSidebar />);
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('G')).toBeInTheDocument();
  });

  it('uses teamInfo name when teamMap has no entry', () => {
    const teams = new Map([
      ['team-x', { token: 'tx', user: {}, teamInfo: { name: 'ExtraTeam' }, baseUrl: 'https://x.example.com' }],
    ]);
    const servers = new Map();
    useAuthStore.setState({ teams, servers });
    useTeamStore.setState({ activeTeamId: 'team-x', teams: new Map() });

    render(<TeamSidebar />);
    expect(screen.getByText('E')).toBeInTheDocument();
  });

  it('renders empty sidebar when no teams', () => {
    useAuthStore.setState({ teams: new Map(), servers: new Map() });
    const { container } = render(<TeamSidebar />);
    expect(container.querySelectorAll('.team-icon').length).toBe(0);
  });
});
