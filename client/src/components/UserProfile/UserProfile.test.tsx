import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import UserProfile from './UserProfile';
import type { Member } from '../../stores/teamStore';
import type { UserPresence } from '../../stores/presenceStore';

vi.mock('../PresenceIndicator/PresenceIndicator', () => ({
  default: ({ status, size }: { status: string; size: string }) => (
    <span data-testid="presence-indicator" data-status={status} data-size={size} />
  ),
}));

const baseMember: Member = {
  id: 'member-1',
  userId: 'user-1',
  username: 'alice',
  displayName: 'Alice Wonderland',
  nickname: '',
  roles: [],
  statusType: 'online',
};

describe('UserProfile', () => {
  it('renders display name and username', () => {
    render(<UserProfile member={baseMember} x={0} y={0} onClose={vi.fn()} />);
    expect(screen.getByText('Alice Wonderland')).toBeInTheDocument();
    expect(screen.getByText('@alice')).toBeInTheDocument();
  });

  it('renders initials from display name', () => {
    const { container } = render(<UserProfile member={baseMember} x={0} y={0} onClose={vi.fn()} />);
    expect(container.querySelector('.user-profile-avatar')?.textContent).toBe('AW');
  });

  it('falls back to username when displayName is empty', () => {
    const member = { ...baseMember, displayName: '' };
    const { container } = render(<UserProfile member={member} x={0} y={0} onClose={vi.fn()} />);
    // "alice".split(' ') = ["alice"], initials = "A"
    expect(container.querySelector('.user-profile-avatar')?.textContent).toBe('A');
  });

  it('renders presence indicator', () => {
    render(<UserProfile member={baseMember} x={0} y={0} onClose={vi.fn()} />);
    expect(screen.getByTestId('presence-indicator')).toBeInTheDocument();
  });

  it('renders offline status when no presence', () => {
    render(<UserProfile member={baseMember} x={0} y={0} onClose={vi.fn()} />);
    const indicator = screen.getByTestId('presence-indicator');
    expect(indicator).toHaveAttribute('data-status', 'offline');
  });

  it('renders correct status from presence', () => {
    const presence: UserPresence = {
      user_id: 'user-1',
      status: 'dnd',
      custom_status: '',
      last_active: '',
    };
    render(<UserProfile member={baseMember} presence={presence} x={0} y={0} onClose={vi.fn()} />);
    const indicator = screen.getByTestId('presence-indicator');
    expect(indicator).toHaveAttribute('data-status', 'dnd');
  });

  it('renders custom status when present', () => {
    const presence: UserPresence = {
      user_id: 'user-1',
      status: 'online',
      custom_status: 'In a meeting',
      last_active: '',
    };
    render(<UserProfile member={baseMember} presence={presence} x={0} y={0} onClose={vi.fn()} />);
    expect(screen.getByText('In a meeting')).toBeInTheDocument();
  });

  it('does not render custom status when empty', () => {
    render(<UserProfile member={baseMember} x={0} y={0} onClose={vi.fn()} />);
    expect(screen.queryByText('.user-profile-custom-status')).not.toBeInTheDocument();
  });

  it('renders roles when member has roles', () => {
    const member = {
      ...baseMember,
      roles: [
        { id: 'r1', name: 'Admin', color: '#ff0000', position: 0, permissions: 0, isDefault: false },
        { id: 'r2', name: 'Mod', color: '#00ff00', position: 1, permissions: 0, isDefault: false },
      ],
    };
    render(<UserProfile member={member} x={0} y={0} onClose={vi.fn()} />);
    expect(screen.getByText('Admin')).toBeInTheDocument();
    expect(screen.getByText('Mod')).toBeInTheDocument();
  });

  it('does not render roles section when empty', () => {
    const { container } = render(<UserProfile member={baseMember} x={0} y={0} onClose={vi.fn()} />);
    expect(container.querySelector('.user-profile-roles')).not.toBeInTheDocument();
  });

  it('renders send message button when onSendMessage is provided', () => {
    render(<UserProfile member={baseMember} x={0} y={0} onSendMessage={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('profile.sendMessage')).toBeInTheDocument();
  });

  it('does not render send message button when onSendMessage is not provided', () => {
    render(<UserProfile member={baseMember} x={0} y={0} onClose={vi.fn()} />);
    expect(screen.queryByText('profile.sendMessage')).not.toBeInTheDocument();
  });

  it('calls onSendMessage when button is clicked', () => {
    const onSendMessage = vi.fn();
    render(<UserProfile member={baseMember} x={0} y={0} onSendMessage={onSendMessage} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('profile.sendMessage'));
    expect(onSendMessage).toHaveBeenCalledTimes(1);
  });

  it('positions popover at given coordinates', () => {
    const { container } = render(<UserProfile member={baseMember} x={200} y={300} onClose={vi.fn()} />);
    const popover = container.querySelector('.user-profile-popover') as HTMLElement;
    expect(popover.style.left).toBe('200px');
    expect(popover.style.top).toBe('300px');
  });

  it('clamps negative x to 0', () => {
    const { container } = render(<UserProfile member={baseMember} x={-50} y={100} onClose={vi.fn()} />);
    const popover = container.querySelector('.user-profile-popover') as HTMLElement;
    expect(popover.style.left).toBe('0px');
  });

  it('stops event propagation on click', () => {
    const { container } = render(<UserProfile member={baseMember} x={0} y={0} onClose={vi.fn()} />);
    const popover = container.querySelector('.user-profile-popover')!;
    const event = new MouseEvent('click', { bubbles: true });
    const stopProp = vi.spyOn(event, 'stopPropagation');
    popover.dispatchEvent(event);
    expect(stopProp).toHaveBeenCalled();
  });
});
