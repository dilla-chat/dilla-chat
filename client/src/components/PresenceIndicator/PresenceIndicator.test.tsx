import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import PresenceIndicator from './PresenceIndicator';

describe('PresenceIndicator', () => {
  it('renders with default medium size', () => {
    const { container } = render(<PresenceIndicator status="online" />);
    const el = container.querySelector('.presence-indicator');
    expect(el).toBeInTheDocument();
    expect(el).toHaveClass('presence-medium');
    expect(el).toHaveAttribute('data-status', 'online');
  });

  it('renders with small size', () => {
    const { container } = render(<PresenceIndicator status="idle" size="small" />);
    const el = container.querySelector('.presence-indicator');
    expect(el).toHaveClass('presence-small');
    expect(el).toHaveAttribute('data-status', 'idle');
  });

  it('renders with large size', () => {
    const { container } = render(<PresenceIndicator status="dnd" size="large" />);
    const el = container.querySelector('.presence-indicator');
    expect(el).toHaveClass('presence-large');
    expect(el).toHaveAttribute('data-status', 'dnd');
  });

  it('renders offline status', () => {
    const { container } = render(<PresenceIndicator status="offline" />);
    const el = container.querySelector('.presence-indicator');
    expect(el).toHaveAttribute('data-status', 'offline');
  });

  it('applies custom className', () => {
    const { container } = render(<PresenceIndicator status="online" className="border-floating" />);
    const el = container.querySelector('.presence-indicator');
    expect(el).toHaveClass('border-floating');
  });

  it('renders as a span element', () => {
    const { container } = render(<PresenceIndicator status="online" />);
    const el = container.querySelector('.presence-indicator');
    expect(el?.tagName).toBe('SPAN');
  });
});
