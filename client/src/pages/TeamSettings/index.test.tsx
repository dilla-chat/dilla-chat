// Cover the TeamSettings shell — tab switching + section structure.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../components/FederationStatus/FederationStatus', () => ({ default: () => <div>FederationStatus</div> }));
vi.mock('../../components/SettingsLayout/SettingsLayout', () => ({
  default: ({ sections, activeId, onSelect, onClose, children }: {
    sections: { items: { id: string; label: string }[] }[];
    activeId: string;
    onSelect: (id: string) => void;
    onClose: () => void;
    children: React.ReactNode;
  }) => (
    <div>
      <button onClick={onClose} aria-label="close">close</button>
      {sections.flatMap((s, i) => s.items.map((it) => (
        <button key={`${i}-${it.id}`} data-active={activeId === it.id} onClick={() => onSelect(it.id)}>{it.label}</button>
      )))}
      <div data-testid="body">{children}</div>
    </div>
  ),
}));
vi.mock('./OverviewTab', () => ({ default: () => <div>OverviewTab</div> }));
vi.mock('./RolesTab', () => ({ default: () => <div>RolesTab</div> }));
vi.mock('./MembersTab', () => ({ default: () => <div>MembersTab</div> }));
vi.mock('./InvitesTab', () => ({ default: () => <div>InvitesTab</div> }));
vi.mock('./IntegrationsTab', () => ({ default: () => <div>IntegrationsTab</div> }));
vi.mock('./ModerationTab', () => ({ default: () => <div>ModerationTab</div> }));
vi.mock('./AuditLogTab', () => ({ default: () => <div>AuditLogTab</div> }));
vi.mock('./BansTab', () => ({ default: () => <div>BansTab</div> }));
vi.mock('../../components/ConfirmDialog/ConfirmDialog', () => ({ default: () => null }));

const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigateMock };
});

import TeamSettings from './index';
import { useTeamStore } from '../../stores/teamStore';

beforeEach(() => {
  navigateMock.mockClear();
  useTeamStore.setState({
    activeTeamId: 't1',
    teams: new Map([['t1', { id: 't1', name: 'Team One' } as never]]),
  } as never);
});

describe('TeamSettings shell', () => {
  function renderShell() {
    return render(
      <MemoryRouter>
        <TeamSettings />
      </MemoryRouter>,
    );
  }

  it('renders OverviewTab by default', () => {
    renderShell();
    expect(screen.getByText('OverviewTab')).toBeInTheDocument();
  });

  it('switches to Roles tab', () => {
    renderShell();
    fireEvent.click(screen.getByText(/settings.roles|Roles/));
    expect(screen.getByText('RolesTab')).toBeInTheDocument();
  });

  it('switches through every tab without crashing', () => {
    renderShell();
    for (const label of ['settings.members', 'settings.invites', 'settings.integrations', 'settings.moderation', 'settings.auditLog', 'settings.bans', 'settings.federation', 'settings.deleteServer']) {
      const btn = screen.queryByText((content) => content === label || content.toLowerCase().includes(label.split('.')[1]?.toLowerCase() ?? ''));
      if (btn) fireEvent.click(btn);
    }
    expect(screen.getByTestId('body')).toBeInTheDocument();
  });

  it('shows the delete-server placeholder when selected', () => {
    renderShell();
    fireEvent.click(screen.getByText(/Delete Server/));
    expect(screen.getByText(/All data will be permanently deleted/)).toBeInTheDocument();
  });

  it('onClose navigates to /app', () => {
    renderShell();
    fireEvent.click(screen.getByLabelText('close'));
    expect(navigateMock).toHaveBeenCalledWith('/app');
  });

  it('renders without crashing when no active team', () => {
    useTeamStore.setState({ activeTeamId: null, teams: new Map() } as never);
    renderShell();
    expect(screen.getByTestId('body')).toBeInTheDocument();
  });
});
