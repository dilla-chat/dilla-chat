import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TeamSidebar from './TeamSidebar';
import { useAuthStore } from '../../stores/authStore';
import { useTeamStore } from '../../stores/teamStore';

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));
vi.mock('iconoir-react', () => ({
  Plus: () => <span data-testid="plus-icon" />,
}));

describe('TeamSidebar', () => {
  beforeEach(() => {
    // Set up auth store with a team
    useAuthStore.setState({
      teams: new Map([
        ['t1', { baseUrl: 'http://localhost', token: 'tok', teamInfo: { name: 'Test Team' }, user: null }],
      ]),
      servers: new Map(),
    });
    useTeamStore.setState({
      activeTeamId: 't1',
      teams: new Map([['t1', { id: 't1', name: 'Test Team', description: '' }]]),
    });
  });

  it('renders team icons as buttons (not divs)', () => {
    render(<TeamSidebar />);
    const teamButton = screen.getByTitle('Test Team');
    expect(teamButton.tagName).toBe('BUTTON');
  });

  it('team icon button is keyboard accessible', () => {
    const setActiveTeam = vi.fn();
    useTeamStore.setState({ setActiveTeam });
    render(<TeamSidebar />);
    const teamButton = screen.getByTitle('Test Team');
    // Button elements are natively focusable and activatable via Enter/Space
    expect(teamButton.tagName).toBe('BUTTON');
    fireEvent.click(teamButton);
    expect(setActiveTeam).toHaveBeenCalledWith('t1');
  });

  it('active team has active class', () => {
    render(<TeamSidebar />);
    const teamButton = screen.getByTitle('Test Team');
    expect(teamButton.className).toContain('active');
  });
});
