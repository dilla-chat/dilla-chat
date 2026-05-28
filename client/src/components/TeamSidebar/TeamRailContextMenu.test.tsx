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

  it('stops keydown propagation from inside the menu (covers L44)', () => {
    const outerKey = vi.fn();
    document.addEventListener('keydown', outerKey);
    render(
      <TeamRailContextMenu
        x={0}
        y={0}
        onClose={() => {}}
        onSettings={() => {}}
        onInvites={() => {}}
        onFederation={() => {}}
        onMarkAllRead={() => {}}
        onLeave={() => {}}
      />,
    );
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'Tab', bubbles: true });
    // The menu's onKeyDown calls stopPropagation, so the document
    // listener never fires for a Tab originating inside the menu.
    expect(outerKey).not.toHaveBeenCalled();
    document.removeEventListener('keydown', outerKey);
  });

  it('stops click propagation from inside the menu', () => {
    const outerClick = vi.fn();
    document.addEventListener('click', outerClick);
    render(
      <TeamRailContextMenu
        x={0}
        y={0}
        onClose={() => {}}
        onSettings={() => {}}
        onInvites={() => {}}
        onFederation={() => {}}
        onMarkAllRead={() => {}}
        onLeave={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('menu'), { bubbles: true });
    expect(outerClick).not.toHaveBeenCalled();
    document.removeEventListener('click', outerClick);
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
