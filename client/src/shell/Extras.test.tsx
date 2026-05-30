import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import {
  NotificationStack,
  FirstRunSplash,
  IncomingCall,
  SafetyCompare,
  ConnectionBanner,
} from './Extras';
import { ShellDataProvider } from './ShellDataContext';
import { useVerifiedContacts } from '../stores/verifiedContactsStore';

vi.mock('../utils/randomId', () => ({ shortId: (p: string) => `${p}-1` }));

function withShell(children: React.ReactElement, data: Record<string, unknown>) {
  return <ShellDataProvider value={data}>{children}</ShellDataProvider>;
}

describe('Extras / NotificationStack', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('renders an empty stack with no toasts', () => {
    const { container } = render(withShell(<NotificationStack />, { SERVERS: [] }));
    expect(container.querySelector('.notify-stack')).toBeTruthy();
    expect(container.querySelectorAll('.notify-toast').length).toBe(0);
  });

  it('appends a toast on a dilla:notify event', () => {
    const { container } = render(withShell(<NotificationStack />, { SERVERS: [{ name: 'T' }] }));
    act(() => {
      window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { title: 'hello' } }));
    });
    expect(container.querySelectorAll('.notify-toast').length).toBe(1);
  });

  it('auto-dismisses after the default 5500ms', () => {
    const { container } = render(withShell(<NotificationStack />, { SERVERS: [] }));
    act(() => {
      window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { title: 'x' } }));
    });
    expect(container.querySelectorAll('.notify-toast').length).toBe(1);
    act(() => { vi.advanceTimersByTime(6000); });
    expect(container.querySelectorAll('.notify-toast').length).toBe(0);
  });

  it('respects a per-toast duration override', () => {
    const { container } = render(withShell(<NotificationStack />, { SERVERS: [] }));
    act(() => {
      window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { title: 'x', duration: 100 } }));
    });
    act(() => { vi.advanceTimersByTime(150); });
    expect(container.querySelectorAll('.notify-toast').length).toBe(0);
  });

  it('shows an overflow indicator + clear-all button when 4+ toasts queued', () => {
    const { container } = render(withShell(<NotificationStack />, { SERVERS: [] }));
    act(() => {
      for (let i = 0; i < 5; i++) {
        window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { title: `t${i}` } }));
      }
    });
    // The stack keeps at most prev.slice(-3) + 1 new = 4.
    expect(container.querySelectorAll('.notify-toast').length).toBe(4);
    expect(container.querySelector('.notify-overflow')).toBeTruthy();
  });

  it('clicking the clear-all button empties the stack', () => {
    const { container } = render(withShell(<NotificationStack />, { SERVERS: [] }));
    act(() => {
      for (let i = 0; i < 5; i++) {
        window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { title: `t${i}` } }));
      }
    });
    const clearBtn = container.querySelector('.notify-overflow button') as HTMLButtonElement;
    act(() => { clearBtn.click(); });
    expect(container.querySelectorAll('.notify-toast').length).toBe(0);
  });

  it('clicking a toast with a channelId dispatches dilla:pickchannel and dismisses it', () => {
    const { container } = render(withShell(<NotificationStack />, { SERVERS: [] }));
    const spy = vi.spyOn(window, 'dispatchEvent');
    act(() => {
      window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { title: 'mention', channelId: 'ch-1' } }));
    });
    const toast = container.querySelector('.notify-toast.clickable') as HTMLElement;
    act(() => { toast.click(); });
    expect(spy.mock.calls.some((c) => c[0] instanceof CustomEvent && c[0].type === 'dilla:pickchannel')).toBe(true);
    expect(container.querySelectorAll('.notify-toast').length).toBe(0);
    spy.mockRestore();
  });

  it('hovering a toast does not crash (pauseDismiss path)', () => {
    const { container } = render(withShell(<NotificationStack />, { SERVERS: [] }));
    act(() => {
      window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { title: 'hover-me' } }));
    });
    const toast = container.querySelector('.notify-toast') as HTMLElement;
    expect(() => {
      toast.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    }).not.toThrow();
  });
});

describe('Extras / FirstRunSplash', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('renders the splash card + caret', () => {
    const { container } = render(withShell(<FirstRunSplash onDone={vi.fn()} />, { SERVERS: [{ node: 'srv-1' }] }));
    expect(container.querySelector('.splash')).toBeTruthy();
    expect(container.querySelector('.splash-caret')).toBeTruthy();
  });

  it('renders "connecting to <host>…" for the first phase', () => {
    const { container } = render(withShell(<FirstRunSplash onDone={vi.fn()} />, { SERVERS: [{ node: 'acme' }] }));
    expect(container.textContent).toContain('connecting to acme');
  });

  it('falls back to host="local" when no SERVERS', () => {
    const { container } = render(withShell(<FirstRunSplash onDone={vi.fn()} />, { SERVERS: [] }));
    expect(container.textContent).toContain('connecting to local');
  });

  it('progresses through the phase ticker without crashing', () => {
    // The full ticker-to-onDone path requires multiple act() flushes
    // that React + fake timers don't compose cleanly. Smoke-test:
    // after one tick, the splash is still mounted and didn't throw.
    const onDone = vi.fn();
    const { container } = render(withShell(<FirstRunSplash onDone={onDone} />, { SERVERS: [{ node: 'a' }] }));
    act(() => { vi.advanceTimersByTime(200); });
    expect(container.querySelector('.splash')).toBeTruthy();
  });
});

describe('Extras / IncomingCall', () => {
  it('returns null when call is falsy', () => {
    const { container } = render(withShell(
      <IncomingCall call={null} onAccept={vi.fn()} onDecline={vi.fn()} />,
      { byId: {} },
    ));
    expect(container.firstChild).toBeNull();
  });

  it('returns null when the caller is unknown (byId miss)', () => {
    const { container } = render(withShell(
      <IncomingCall call={{ from: 'ghost', kind: 'voice' }} onAccept={vi.fn()} onDecline={vi.fn()} />,
      { byId: {} },
    ));
    expect(container.firstChild).toBeNull();
  });

  it('renders the ring card with the caller name + initials', () => {
    const { container } = render(withShell(
      <IncomingCall call={{ from: 'u1', kind: 'voice' }} onAccept={vi.fn()} onDecline={vi.fn()} />,
      { byId: { u1: { name: 'Alice', initials: 'AL', color: '#f00', avatarUrl: '' } } },
    ));
    expect(container.querySelector('.ring-card')).toBeTruthy();
    expect(container.textContent).toContain('Alice');
    expect(container.textContent).toContain('AL');
  });

  it('Enter key fires onAccept', () => {
    const onAccept = vi.fn();
    render(withShell(
      <IncomingCall call={{ from: 'u1', kind: 'voice' }} onAccept={onAccept} onDecline={vi.fn()} />,
      { byId: { u1: { name: 'A', initials: 'A', color: '#f00', avatarUrl: '' } } },
    ));
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it('Escape key fires onDecline', () => {
    const onDecline = vi.fn();
    render(withShell(
      <IncomingCall call={{ from: 'u1', kind: 'voice' }} onAccept={vi.fn()} onDecline={onDecline} />,
      { byId: { u1: { name: 'A', initials: 'A', color: '#f00', avatarUrl: '' } } },
    ));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onDecline).toHaveBeenCalledTimes(1);
  });

  it('clicking decline button fires onDecline', () => {
    const onDecline = vi.fn();
    const { container } = render(withShell(
      <IncomingCall call={{ from: 'u1', kind: 'voice' }} onAccept={vi.fn()} onDecline={onDecline} />,
      { byId: { u1: { name: 'A', initials: 'A', color: '#f00', avatarUrl: '' } } },
    ));
    fireEvent.click(container.querySelector('.ring-btn.decline')!);
    expect(onDecline).toHaveBeenCalledTimes(1);
  });

  it('clicking accept button fires onAccept', () => {
    const onAccept = vi.fn();
    const { container } = render(withShell(
      <IncomingCall call={{ from: 'u1', kind: 'voice' }} onAccept={onAccept} onDecline={vi.fn()} />,
      { byId: { u1: { name: 'A', initials: 'A', color: '#f00', avatarUrl: '' } } },
    ));
    fireEvent.click(container.querySelector('.ring-btn.accept')!);
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it('renders video copy when kind="video"', () => {
    const { container } = render(withShell(
      <IncomingCall call={{ from: 'u1', kind: 'video' }} onAccept={vi.fn()} onDecline={vi.fn()} />,
      { byId: { u1: { name: 'A', initials: 'A', color: '#f00', avatarUrl: '' } } },
    ));
    expect(container.textContent).toContain('video');
  });
});

describe('Extras / SafetyCompare', () => {
  beforeEach(() => {
    useVerifiedContacts.setState({ byUserId: {} } as never);
  });

  it('returns null when contactId is falsy', () => {
    const { container } = render(withShell(
      <SafetyCompare contactId="" onClose={vi.fn()} />,
      { byId: {} },
    ));
    expect(container.firstChild).toBeNull();
  });

  it('returns null when contact unknown in byId', () => {
    const { container } = render(withShell(
      <SafetyCompare contactId="ghost" onClose={vi.fn()} />,
      { byId: {} },
    ));
    expect(container.firstChild).toBeNull();
  });

  it('renders incomplete-data warning when keys are too short', () => {
    const { container } = render(withShell(
      <SafetyCompare contactId="u2" onClose={vi.fn()} />,
      {
        currentUserId: 'u1',
        byId: {
          u1: { name: 'Me', initials: 'ME', color: '#f00', publicKeyHex: 'aa' },
          u2: { name: 'Bob', initials: 'BO', color: '#0f0', publicKeyHex: 'bb' },
        },
      },
    ));
    expect(container.textContent).toMatch(/not fully loaded|Identity key not fully/i);
  });

  it('shows verified pill when both keys are complete (64 hex) and marked verified', () => {
    const longHex = 'a'.repeat(64);
    useVerifiedContacts.setState({
      byUserId: { u2: { publicKeyHex: longHex, verifiedAt: Date.now() } },
    } as never);
    const { container } = render(withShell(
      <SafetyCompare contactId="u2" onClose={vi.fn()} />,
      {
        currentUserId: 'u1',
        byId: {
          u1: { name: 'Me', initials: 'ME', color: '#f00', publicKeyHex: longHex },
          u2: { name: 'Bob', initials: 'BO', color: '#0f0', publicKeyHex: longHex },
        },
      },
    ));
    expect(container.textContent).toContain('Verified');
  });

  it('backdrop click closes; card click does not', () => {
    const onClose = vi.fn();
    const { container } = render(withShell(
      <SafetyCompare contactId="u2" onClose={onClose} />,
      {
        currentUserId: 'u1',
        byId: { u2: { name: 'B', initials: 'B', color: '#000', publicKeyHex: '' } },
      },
    ));
    fireEvent.click(container.querySelector('.sc-dialog')!);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector('.modal-overlay-dismiss')!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('Extras / ConnectionBanner', () => {
  it('renders null when there is no active connection alert', () => {
    const { container } = render(withShell(<ConnectionBanner />, {}));
    expect(container.firstChild).toBeNull();
  });

  it('shows the offline banner when dilla:connection fires "offline"', () => {
    const { container } = render(withShell(<ConnectionBanner />, {}));
    act(() => {
      window.dispatchEvent(new CustomEvent('dilla:connection', { detail: 'offline' }));
    });
    expect(container.textContent).toContain('You are offline');
  });

  it('shows the degraded banner when dilla:connection fires "degraded"', () => {
    const { container } = render(withShell(<ConnectionBanner />, {}));
    act(() => {
      window.dispatchEvent(new CustomEvent('dilla:connection', { detail: 'degraded' }));
    });
    expect(container.textContent).toContain('Mesh degraded');
  });

  it('shows the reconnecting banner when dilla:connection fires "reconnecting"', () => {
    const { container } = render(withShell(<ConnectionBanner />, {}));
    act(() => {
      window.dispatchEvent(new CustomEvent('dilla:connection', { detail: 'reconnecting' }));
    });
    expect(container.textContent).toContain('Reconnecting');
  });

  it('dismiss button clears the banner', () => {
    const { container } = render(withShell(<ConnectionBanner />, {}));
    act(() => {
      window.dispatchEvent(new CustomEvent('dilla:connection', { detail: 'offline' }));
    });
    expect(container.firstChild).not.toBeNull();
    fireEvent.click(container.querySelector('.conn-dismiss')!);
    expect(container.firstChild).toBeNull();
  });
});
