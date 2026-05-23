import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import Skeleton from './Skeleton';
import MessageSkeleton from './MessageSkeleton';

describe('Skeleton', () => {
  it('renders a div with the skeleton class', () => {
    const { container } = render(<Skeleton />);
    const el = container.querySelector('.skeleton');
    expect(el).not.toBeNull();
  });

  it('honors width/height/borderRadius props in inline style', () => {
    const { container } = render(<Skeleton width={120} height={20} borderRadius={6} />);
    const el = container.querySelector('.skeleton') as HTMLElement;
    expect(el.style.width).toBe('120px');
    expect(el.style.height).toBe('20px');
    expect(el.style.borderRadius).toBe('6px');
  });

  it('appends className when provided', () => {
    const { container } = render(<Skeleton className="extra" />);
    const el = container.querySelector('.skeleton');
    expect(el?.className).toContain('extra');
  });

  it('is aria-hidden so screen readers skip the placeholder', () => {
    const { container } = render(<Skeleton />);
    expect(container.querySelector('.skeleton')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('MessageSkeleton', () => {
  it('renders the default count (5) of skeleton rows', () => {
    const { container } = render(<MessageSkeleton />);
    const rows = container.querySelectorAll('.skeleton-message');
    expect(rows.length).toBe(5);
  });

  it('honors a custom count', () => {
    const { container } = render(<MessageSkeleton count={3} />);
    expect(container.querySelectorAll('.skeleton-message').length).toBe(3);
  });

  it('renders an avatar skeleton + meta + content per row', () => {
    const { container } = render(<MessageSkeleton count={1} />);
    expect(container.querySelector('.skeleton-message-avatar')).not.toBeNull();
    expect(container.querySelector('.skeleton-message-meta')).not.toBeNull();
    expect(container.querySelector('.skeleton-message-content')).not.toBeNull();
  });

  it('count=0 produces an empty fragment', () => {
    const { container } = render(<MessageSkeleton count={0} />);
    expect(container.querySelectorAll('.skeleton-message').length).toBe(0);
  });
});
