import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import UserPopover from './UserPopover';

const baseProps = {
  username: 'alice',
  userId: 'a2de720d0616a638ebc3f4fe0487e9018b',
  avatarColor: '#0ea5c0',
  position: { top: 100, left: 50 },
  onClose: vi.fn(),
};

describe('UserPopover', () => {
  beforeEach(() => {
    cleanup();
  });

  it('renders username and initials', () => {
    render(<UserPopover {...baseProps} />);
    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(screen.getByText('AL')).toBeInTheDocument();
  });

  it('renders truncated fingerprint', () => {
    render(<UserPopover {...baseProps} />);
    expect(screen.getByText('a2de72...018b')).toBeInTheDocument();
  });

  it('renders short userId in full when shorter than 8 chars', () => {
    render(<UserPopover {...baseProps} userId="abc" />);
    expect(screen.getByText('abc')).toBeInTheDocument();
  });

  it('renders roles when provided', () => {
    render(<UserPopover {...baseProps} roles={['Admin', 'Moderator']} />);
    expect(screen.getByText('Admin')).toBeInTheDocument();
    expect(screen.getByText('Moderator')).toBeInTheDocument();
  });

  it('does not render roles section when empty', () => {
    const { container } = render(<UserPopover {...baseProps} roles={[]} />);
    expect(container.querySelector('.user-popover-roles')).not.toBeInTheDocument();
  });

  it('renders Message button only when onMessage provided', () => {
    const onMessage = vi.fn();
    render(<UserPopover {...baseProps} onMessage={onMessage} />);
    fireEvent.click(screen.getByText('Message'));
    expect(onMessage).toHaveBeenCalled();
  });

  it('renders Mention button only when onMention provided', () => {
    const onMention = vi.fn();
    render(<UserPopover {...baseProps} onMention={onMention} />);
    fireEvent.click(screen.getByText('Mention'));
    expect(onMention).toHaveBeenCalled();
  });

  it('omits action buttons when no callbacks supplied', () => {
    render(<UserPopover {...baseProps} />);
    expect(screen.queryByText('Message')).not.toBeInTheDocument();
    expect(screen.queryByText('Mention')).not.toBeInTheDocument();
  });

  it('closes on outside mousedown', () => {
    const onClose = vi.fn();
    render(<UserPopover {...baseProps} onClose={onClose} />);
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });

  it('does not close when clicking inside', () => {
    const onClose = vi.fn();
    render(<UserPopover {...baseProps} onClose={onClose} />);
    fireEvent.mouseDown(screen.getByText('alice'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('applies position styling', () => {
    render(<UserPopover {...baseProps} position={{ top: 200, left: 75 }} />);
    const popover = document.querySelector('.user-popover') as HTMLElement;
    expect(popover.style.top).toBe('200px');
    expect(popover.style.left).toBe('75px');
  });
});
