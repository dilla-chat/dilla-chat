import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TeamRailContextMenu from './TeamRailContextMenu';

describe('TeamRailContextMenu', () => {
  it('renders 5 menu items when open', () => {
    render(
      <TeamRailContextMenu
        x={100}
        y={100}
        onClose={() => {}}
        onSettings={() => {}}
        onInvites={() => {}}
        onFederation={() => {}}
        onMarkAllRead={() => {}}
        onLeave={() => {}}
      />,
    );
    expect(screen.getByText(/settings/i)).toBeInTheDocument();
    expect(screen.getByText(/invites/i)).toBeInTheDocument();
    expect(screen.getByText(/federation/i)).toBeInTheDocument();
    expect(screen.getByText(/mark all read/i)).toBeInTheDocument();
    expect(screen.getByText(/leave/i)).toBeInTheDocument();
  });

  it('calls handlers and closes on item click', () => {
    const onSettings = vi.fn();
    const onClose = vi.fn();
    render(
      <TeamRailContextMenu
        x={0}
        y={0}
        onClose={onClose}
        onSettings={onSettings}
        onInvites={() => {}}
        onFederation={() => {}}
        onMarkAllRead={() => {}}
        onLeave={() => {}}
      />,
    );
    fireEvent.click(screen.getByText(/settings/i));
    expect(onSettings).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(
      <TeamRailContextMenu
        x={0}
        y={0}
        onClose={onClose}
        onSettings={() => {}}
        onInvites={() => {}}
        onFederation={() => {}}
        onMarkAllRead={() => {}}
        onLeave={() => {}}
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
