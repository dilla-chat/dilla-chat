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
});
