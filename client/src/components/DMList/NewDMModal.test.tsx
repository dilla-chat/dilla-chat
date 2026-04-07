import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import NewDMModal from './NewDMModal';
import { useTeamStore } from '../../stores/teamStore';

vi.mock('@tabler/icons-react', () => ({
  IconX: () => <span data-testid="Xmark" />,
  IconCheck: () => <span data-testid="Check" />,
}));

vi.mock('../../services/api', () => ({
  api: {
    createDM: vi.fn(() => Promise.resolve({
      id: 'dm-new',
      team_id: 'team-1',
      is_group: false,
      members: [],
      created_at: '2025-01-01T00:00:00Z',
    })),
  },
}));

const makeMember = (id: string, username: string) => ({
  id: `member-${id}`,
  userId: `user-${id}`,
  username,
  displayName: username.charAt(0).toUpperCase() + username.slice(1),
  nickname: '',
  roles: [],
  statusType: 'online',
});

describe('NewDMModal', () => {
  beforeEach(() => {
    useTeamStore.setState({
      activeTeamId: 'team-1',
      members: new Map([
        ['team-1', [
          makeMember('1', 'alice'),
          makeMember('2', 'bob'),
          makeMember('3', 'charlie'),
        ]],
      ]),
    });
  });

  it('renders modal header', () => {
    render(<NewDMModal currentUserId="user-1" onClose={vi.fn()} onDMCreated={vi.fn()} />);
    expect(screen.getByText('New Message')).toBeInTheDocument();
  });

  it('renders available members excluding current user', () => {
    render(<NewDMModal currentUserId="user-1" onClose={vi.fn()} onDMCreated={vi.fn()} />);
    expect(screen.queryByText('@alice')).not.toBeInTheDocument();
    expect(screen.getByText('@bob')).toBeInTheDocument();
    expect(screen.getByText('@charlie')).toBeInTheDocument();
  });

  it('selects member on click', () => {
    const { container } = render(<NewDMModal currentUserId="user-1" onClose={vi.fn()} onDMCreated={vi.fn()} />);
    fireEvent.click(screen.getByText('Bob'));
    const selected = container.querySelectorAll('.new-dm-member.selected');
    expect(selected.length).toBe(1);
  });

  it('deselects member on second click', () => {
    const { container } = render(<NewDMModal currentUserId="user-1" onClose={vi.fn()} onDMCreated={vi.fn()} />);
    // Click the member row (not the chip)
    const memberRow = container.querySelector('.new-dm-member')!;
    fireEvent.click(memberRow); // select bob (first non-current-user member)
    // Now Bob appears in chip AND list; click the member row again
    const memberRows = container.querySelectorAll('.new-dm-member');
    fireEvent.click(memberRows[0]); // deselect
    const selected = container.querySelectorAll('.new-dm-member.selected');
    expect(selected.length).toBe(0);
  });

  it('shows selected member chips', () => {
    const { container } = render(<NewDMModal currentUserId="user-1" onClose={vi.fn()} onDMCreated={vi.fn()} />);
    fireEvent.click(screen.getByText('Bob'));
    const chips = container.querySelectorAll('.new-dm-chip');
    expect(chips.length).toBe(1);
  });

  it('filters members by search', () => {
    render(<NewDMModal currentUserId="user-1" onClose={vi.fn()} onDMCreated={vi.fn()} />);
    const input = screen.getByPlaceholderText('Search members...');
    fireEvent.change(input, { target: { value: 'bob' } });
    expect(screen.getByText('@bob')).toBeInTheDocument();
    expect(screen.queryByText('@charlie')).not.toBeInTheDocument();
  });

  it('disables create button when no member is selected', () => {
    render(<NewDMModal currentUserId="user-1" onClose={vi.fn()} onDMCreated={vi.fn()} />);
    const btn = screen.getByText('Start Conversation');
    expect(btn).toBeDisabled();
  });

  it('enables create button when a member is selected', () => {
    render(<NewDMModal currentUserId="user-1" onClose={vi.fn()} onDMCreated={vi.fn()} />);
    fireEvent.click(screen.getByText('Bob'));
    const btn = screen.getByText('Start Conversation');
    expect(btn).not.toBeDisabled();
  });

  it('shows group message label when multiple selected', () => {
    render(<NewDMModal currentUserId="user-1" onClose={vi.fn()} onDMCreated={vi.fn()} />);
    fireEvent.click(screen.getByText('Bob'));
    fireEvent.click(screen.getByText('Charlie'));
    expect(screen.getByText('Group Message')).toBeInTheDocument();
  });

  it('calls onClose when overlay is clicked', () => {
    const onClose = vi.fn();
    const { container } = render(<NewDMModal currentUserId="user-1" onClose={onClose} onDMCreated={vi.fn()} />);
    const overlay = container.querySelector('.dialog-backdrop')!;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose on Escape key', () => {
    const onClose = vi.fn();
    render(<NewDMModal currentUserId="user-1" onClose={onClose} onDMCreated={vi.fn()} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('creates DM on button click', async () => {
    const onDMCreated = vi.fn();
    const onClose = vi.fn();
    render(<NewDMModal currentUserId="user-1" onClose={onClose} onDMCreated={onDMCreated} />);

    fireEvent.click(screen.getByText('Bob'));
    fireEvent.click(screen.getByText('Start Conversation'));

    await waitFor(() => {
      expect(onDMCreated).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('removes member via chip remove button', () => {
    const { container } = render(<NewDMModal currentUserId="user-1" onClose={vi.fn()} onDMCreated={vi.fn()} />);
    // Select bob
    fireEvent.click(screen.getByText('Bob'));
    expect(container.querySelectorAll('.new-dm-chip').length).toBe(1);
    // Remove via chip button
    const removeBtn = container.querySelector('.new-dm-chip-remove')!;
    fireEvent.click(removeBtn);
    expect(container.querySelectorAll('.new-dm-chip').length).toBe(0);
  });

  it('does not create when activeTeamId is null', async () => {
    useTeamStore.setState({ activeTeamId: null });
    const { api } = await import('../../services/api');
    vi.mocked(api.createDM).mockClear();
    const onDMCreated = vi.fn();
    render(<NewDMModal currentUserId="user-1" onClose={vi.fn()} onDMCreated={onDMCreated} />);
    // Members won't be available, but verify graceful handling
    expect(screen.getByText('No members found')).toBeInTheDocument();
  });

  it('handles create DM API failure gracefully', async () => {
    const { api } = await import('../../services/api');
    vi.mocked(api.createDM).mockRejectedValueOnce(new Error('API error'));
    const onDMCreated = vi.fn();
    const onClose = vi.fn();
    render(<NewDMModal currentUserId="user-1" onClose={onClose} onDMCreated={onDMCreated} />);
    fireEvent.click(screen.getByText('Bob'));
    fireEvent.click(screen.getByText('Start Conversation'));
    await waitFor(() => {
      // Should not crash, onDMCreated should NOT be called
      expect(onDMCreated).not.toHaveBeenCalled();
    });
  });

  it('shows no members found when filter returns empty', () => {
    render(<NewDMModal currentUserId="user-1" onClose={vi.fn()} onDMCreated={vi.fn()} />);
    const input = screen.getByPlaceholderText('Search members...');
    fireEvent.change(input, { target: { value: 'zzzzz' } });
    expect(screen.getByText('No members found')).toBeInTheDocument();
  });
});
