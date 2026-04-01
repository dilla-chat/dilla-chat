import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ContentErrorBoundary from './ContentErrorBoundary';

vi.mock('../../services/telemetry', () => ({
  recordException: vi.fn(),
}));

function BrokenChild() {
  throw new Error('test crash');
}

function GoodChild() {
  return <div>Works fine</div>;
}

describe('ContentErrorBoundary', () => {
  it('renders children when no error', () => {
    render(
      <ContentErrorBoundary>
        <GoodChild />
      </ContentErrorBoundary>,
    );
    expect(screen.getByText('Works fine')).toBeInTheDocument();
  });

  it('shows fallback on error', () => {
    // Suppress console.error from React's error boundary
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ContentErrorBoundary>
        <BrokenChild />
      </ContentErrorBoundary>,
    );
    expect(screen.getByText('This section encountered an error.')).toBeInTheDocument();
    expect(screen.getByText('test crash')).toBeInTheDocument();
    spy.mockRestore();
  });

  it('uses custom fallback label', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ContentErrorBoundary fallbackLabel="Custom error">
        <BrokenChild />
      </ContentErrorBoundary>,
    );
    expect(screen.getByText('Custom error')).toBeInTheDocument();
    spy.mockRestore();
  });

  it('recovers on retry click', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let shouldThrow = true;

    function MaybeBroken() {
      if (shouldThrow) throw new Error('crash');
      return <div>Recovered</div>;
    }

    render(
      <ContentErrorBoundary>
        <MaybeBroken />
      </ContentErrorBoundary>,
    );
    expect(screen.getByText('This section encountered an error.')).toBeInTheDocument();

    shouldThrow = false;
    fireEvent.click(screen.getByText('Retry'));
    expect(screen.getByText('Recovered')).toBeInTheDocument();
    spy.mockRestore();
  });
});
