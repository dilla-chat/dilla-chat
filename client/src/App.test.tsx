// Cover the top-level App component (router config + error boundary + auth redirect).

import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
vi.mock('./i18n', () => ({}));
vi.mock('./services/telemetry', () => ({ recordException: vi.fn() }));
vi.mock('./services/keyStore', () => ({ hasIdentity: vi.fn(async () => false) }));
vi.mock('./pages/CreateIdentity', () => ({ default: () => <div>CreateIdentity</div> }));
vi.mock('./pages/Login', () => ({ default: () => <div>Login</div> }));
vi.mock('./pages/JoinTeam', () => ({ default: () => <div>JoinTeam</div> }));
vi.mock('./pages/RecoverFromServer', () => ({ default: () => <div>RecoverFromServer</div> }));
vi.mock('./pages/SetupAdmin', () => ({ default: () => <div>SetupAdmin</div> }));
vi.mock('./pages/App', () => ({ default: () => <div>AppPage</div> }));
vi.mock('./pages/TeamSettings', () => ({ default: () => <div>TeamSettings</div> }));
vi.mock('./pages/UserSettings', () => ({ default: () => <div>UserSettings</div> }));
vi.mock('./pages/Onboarding/Onboarding', () => ({ default: () => <div>Onboarding</div> }));
vi.mock('./pages/NotFound', () => ({ default: () => <div>NotFound</div> }));

// Wrap App but use MemoryRouter so route handling is testable without BrowserRouter
import App from './App';
import { useAuthStore } from './stores/authStore';

describe('App router', () => {
  it('renders the App shell without crashing', () => {
    useAuthStore.setState({ isAuthenticated: false } as never);
    const { container } = render(<App />);
    expect(container.firstChild).toBeTruthy();
  });

  it('module exports default function', () => {
    expect(typeof App).toBe('function');
  });

  it('redirects from /join/:token to onboarding with mode=invite', async () => {
    useAuthStore.setState({ isAuthenticated: false } as never);
    window.history.pushState({}, '', '/join/some-token');
    const { container } = render(<App />);
    // After redirect we should land on Onboarding mock.
    await new Promise((r) => setTimeout(r, 10));
    expect(container.textContent).toContain('Onboarding');
  });

  it('redirects /create-identity → /onboarding', async () => {
    useAuthStore.setState({ isAuthenticated: false } as never);
    window.history.pushState({}, '', '/create-identity');
    const { container } = render(<App />);
    await new Promise((r) => setTimeout(r, 10));
    expect(container.textContent).toContain('Onboarding');
  });

  it('redirects /setup → /onboarding?mode=bootstrap', async () => {
    useAuthStore.setState({ isAuthenticated: false } as never);
    window.history.pushState({}, '', '/setup');
    const { container } = render(<App />);
    await new Promise((r) => setTimeout(r, 10));
    expect(container.textContent).toContain('Onboarding');
  });

  it('routes /app to the main AppPage when authenticated', async () => {
    useAuthStore.setState({ isAuthenticated: true } as never);
    window.history.pushState({}, '', '/app');
    const { container } = render(<App />);
    await new Promise((r) => setTimeout(r, 10));
    expect(container.textContent).toContain('AppPage');
  });

  it('routes unknown paths to NotFound', async () => {
    useAuthStore.setState({ isAuthenticated: false } as never);
    window.history.pushState({}, '', '/totally-not-a-route');
    const { container } = render(<App />);
    await new Promise((r) => setTimeout(r, 10));
    expect(container.textContent).toContain('NotFound');
  });

  it('authenticated AuthRedirect routes to /app', async () => {
    useAuthStore.setState({ isAuthenticated: true } as never);
    window.history.pushState({}, '', '/');
    const { container } = render(<App />);
    await new Promise((r) => setTimeout(r, 50));
    expect(container.textContent).toContain('AppPage');
  });

  it('renders /create-identity-legacy → CreateIdentity', async () => {
    useAuthStore.setState({ isAuthenticated: false } as never);
    window.history.pushState({}, '', '/create-identity-legacy');
    const { container } = render(<App />);
    await new Promise((r) => setTimeout(r, 10));
    expect(container.textContent).toContain('CreateIdentity');
  });

  it('renders /login-legacy → Login', async () => {
    useAuthStore.setState({ isAuthenticated: false } as never);
    window.history.pushState({}, '', '/login-legacy');
    const { container } = render(<App />);
    await new Promise((r) => setTimeout(r, 10));
    expect(container.textContent).toContain('Login');
  });

  it('renders /recover-legacy → RecoverFromServer', async () => {
    useAuthStore.setState({ isAuthenticated: false } as never);
    window.history.pushState({}, '', '/recover-legacy');
    const { container } = render(<App />);
    await new Promise((r) => setTimeout(r, 10));
    expect(container.textContent).toContain('RecoverFromServer');
  });

  it('renders /setup-legacy → SetupAdmin', async () => {
    useAuthStore.setState({ isAuthenticated: false } as never);
    window.history.pushState({}, '', '/setup-legacy');
    const { container } = render(<App />);
    await new Promise((r) => setTimeout(r, 10));
    expect(container.textContent).toContain('SetupAdmin');
  });

  it('AuthRedirect catch path defaults to /onboarding when hasIdentity throws', async () => {
    // Re-mock keyStore so hasIdentity throws — exercises the catch arm.
    const ks = await import('./services/keyStore');
    (ks.hasIdentity as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('idb broken'));
    useAuthStore.setState({ isAuthenticated: false } as never);
    window.history.pushState({}, '', '/');
    const { container } = render(<App />);
    await new Promise((r) => setTimeout(r, 50));
    expect(container.textContent).toContain('Onboarding');
  });

  it('ErrorBoundary catches a child render error and shows the fallback UI', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Override the Onboarding mock to throw on render.
    vi.doMock('./pages/Onboarding/Onboarding', () => ({
      default: () => {
        throw new Error('boom-from-onboarding');
      },
    }));
    vi.resetModules();
    const { default: FreshApp } = await import('./App');
    useAuthStore.setState({ isAuthenticated: false } as never);
    window.history.pushState({}, '', '/onboarding');
    const { container } = render(<FreshApp />);
    await new Promise((r) => setTimeout(r, 50));
    expect(container.textContent).toContain('Something went wrong');
    expect(container.textContent).toContain('boom-from-onboarding');
    // Click the Restart App button to exercise L52.
    const btn = Array.from(container.querySelectorAll('button')).find(
      (b) => /restart/i.test(b.textContent ?? ''),
    ) as HTMLButtonElement | undefined;
    expect(btn).toBeTruthy();
    // Stub globalThis.location to a writable object so the click
    // handler's `globalThis.location.href = '/'` doesn't crash jsdom.
    const realLoc = globalThis.location;
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { href: 'http://test/' },
    });
    try {
      btn!.click();
    } finally {
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: realLoc,
      });
    }
    errSpy.mockRestore();
  });
});
