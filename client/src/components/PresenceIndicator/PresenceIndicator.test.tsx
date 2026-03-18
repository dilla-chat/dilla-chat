import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import PresenceIndicator from './PresenceIndicator';

describe('PresenceIndicator', () => {
  it('renders with role="img" and aria-label for online', () => {
    render(<PresenceIndicator status="online" />);
    const el = screen.getByRole('img', { name: 'Online' });
    expect(el).toBeInTheDocument();
    expect(el).toHaveAttribute('data-status', 'online');
  });

  it('renders correct aria-label for idle', () => {
    render(<PresenceIndicator status="idle" />);
    expect(screen.getByRole('img', { name: 'Idle' })).toBeInTheDocument();
  });

  it('renders correct aria-label for dnd', () => {
    render(<PresenceIndicator status="dnd" />);
    expect(screen.getByRole('img', { name: 'Do Not Disturb' })).toBeInTheDocument();
  });

  it('renders correct aria-label for offline', () => {
    render(<PresenceIndicator status="offline" />);
    expect(screen.getByRole('img', { name: 'Offline' })).toBeInTheDocument();
  });

  it('applies size class', () => {
    render(<PresenceIndicator status="online" size="small" />);
    const el = screen.getByRole('img');
    expect(el.className).toContain('presence-small');
  });
});
