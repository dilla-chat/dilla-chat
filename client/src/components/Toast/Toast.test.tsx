import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ToastProvider } from './Toast';
import { useToast } from './useToast';

function TestConsumer() {
  const { toast } = useToast();
  return (
    <div>
      <button onClick={() => toast('Success!', 'success')}>Show Success</button>
      <button onClick={() => toast('Error!', 'error')}>Show Error</button>
      <button onClick={() => toast('Info message')}>Show Info</button>
    </div>
  );
}

describe('Toast', () => {
  it('shows a toast when triggered', () => {
    render(
      <ToastProvider>
        <TestConsumer />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('Show Success'));
    expect(screen.getByText('Success!')).toBeInTheDocument();
  });

  it('applies correct CSS class for toast type', () => {
    render(
      <ToastProvider>
        <TestConsumer />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('Show Error'));
    const toast = screen.getByText('Error!').closest('.toast');
    expect(toast).toHaveClass('toast-error');
  });

  it('defaults to info type', () => {
    render(
      <ToastProvider>
        <TestConsumer />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('Show Info'));
    const toast = screen.getByText('Info message').closest('.toast');
    expect(toast).toHaveClass('toast-info');
  });

  it('dismisses toast on button click', () => {
    render(
      <ToastProvider>
        <TestConsumer />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('Show Success'));
    expect(screen.getByText('Success!')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Dismiss'));
    expect(screen.queryByText('Success!')).not.toBeInTheDocument();
  });

  it('auto-dismisses after timeout', () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <TestConsumer />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('Show Success'));
    expect(screen.getByText('Success!')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(4500);
    });
    expect(screen.queryByText('Success!')).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('shows multiple toasts', () => {
    render(
      <ToastProvider>
        <TestConsumer />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('Show Success'));
    fireEvent.click(screen.getByText('Show Error'));
    expect(screen.getByText('Success!')).toBeInTheDocument();
    expect(screen.getByText('Error!')).toBeInTheDocument();
  });

  it('has accessible role and aria-live', () => {
    render(
      <ToastProvider>
        <TestConsumer />
      </ToastProvider>,
    );
    const container = document.querySelector('.toast-container');
    expect(container).toHaveAttribute('role', 'status');
    expect(container).toHaveAttribute('aria-live', 'polite');
  });
});
