import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import FirstRunSplash from './FirstRunSplash';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('FirstRunSplash', () => {
  it('renders the brand mark and a status landmark', () => {
    render(<FirstRunSplash durationMs={1000} />);
    expect(screen.getByRole('status', { name: /dilla starting/i })).toBeInTheDocument();
    expect(screen.getByText(/dilla/i)).toBeInTheDocument();
  });

  it('progressively reveals boot log lines', () => {
    render(<FirstRunSplash durationMs={500} />);
    // First line is visible immediately
    expect(screen.getByText(/initialising mesh runtime/i)).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    // After full duration, more lines should have appeared
    expect(screen.getByText(/ok/i)).toBeInTheDocument();
  });

  it('calls onDone after duration + fade', () => {
    const onDone = vi.fn();
    render(<FirstRunSplash durationMs={500} onDone={onDone} />);
    expect(onDone).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('renders nothing once done', () => {
    render(<FirstRunSplash durationMs={300} />);
    expect(document.querySelector('.first-run-splash')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(700);
    });
    // After phase=done, portal content is null
    expect(document.querySelector('.first-run-splash')).toBeNull();
  });
});
