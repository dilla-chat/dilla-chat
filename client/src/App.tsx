import { Component, type ReactNode, useEffect, useState, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom';
import { useAuthStore } from './stores/authStore';
import { recordException } from './services/telemetry';
import './i18n';
import './App.css';

import CreateIdentity from './pages/CreateIdentity';
import Login from './pages/Login';
import JoinTeam from './pages/JoinTeam';
import RecoverFromServer from './pages/RecoverFromServer';
import SetupAdmin from './pages/SetupAdmin';
import AppPage from './pages/App';
import TeamSettings from './pages/TeamSettings';
import UserSettings from './pages/UserSettings';
import Onboarding from './pages/Onboarding/Onboarding';
import NotFound from './pages/NotFound';
import { ToastProvider } from './components/Toast/Toast';
// useToast hook available from './components/Toast/useToast' for consumer components

const DEMO_ENABLED = import.meta.env.VITE_DEMO === 'true';

// Deep-link redirect for invite emails. Old URLs land on /join/:token; we
// now drive enrollment through /onboarding's invite mode with the token
// pre-filled. JoinTeam itself stays available as /join-legacy for now in
// case any flow still depends on the original component.
function InviteRedirect() {
  const { token } = useParams<{ token?: string }>();
  const qs = token ? `?mode=invite&token=${encodeURIComponent(token)}` : '?mode=invite';
  return <Navigate to={`/onboarding${qs}`} replace />;
}

// Lazy-load the mock shell (ported handoff JSX driven by mock services)
// only when VITE_DEMO=true. This is the canonical preview view.
const MockShell = DEMO_ENABLED
  ? lazy(() => import('./shell/MockShell'))
  : () => <Navigate to="/" replace />;

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) {
    recordException(error, 'ErrorBoundary');
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: '2rem', color: 'var(--text-danger)', background: 'var(--bg-tertiary)', height: '100vh' }}>
          <h1>Something went wrong</h1>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: '14px' }}>{this.state.error.message}</pre>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: '12px', color: 'var(--text-muted)' }}>{this.state.error.stack}</pre>
          <button onClick={() => { this.setState({ error: null }); globalThis.location.href = '/'; }}
            style={{ marginTop: '1rem', padding: '0.5rem 1rem', cursor: 'pointer' }}>
            Restart App
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function AuthRedirect() {
  const { isAuthenticated } = useAuthStore();
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    if (isAuthenticated) {
      setTarget('/app');
      return;
    }
    (async () => {
      try {
        const { hasIdentity } = await import('./services/keyStore');
        const exists = await hasIdentity();
        setTarget(exists ? '/onboarding?mode=existing' : '/onboarding');
      } catch {
        setTarget('/onboarding');
      }
    })();
  }, [isAuthenticated]);

  if (!target) return null;
  return <Navigate to={target} replace />;
}

function App() {
  return (
    <ErrorBoundary>
    <ToastProvider>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<AuthRedirect />} />
        <Route path="/welcome" element={<Navigate to="/" replace />} />
        {/* Design-first sandbox — ported handoff JSX driven by the same
            mock services as the real app. Behind VITE_DEMO. */}
        {DEMO_ENABLED && (
          <Route path="/mesh" element={
            <Suspense fallback={null}><MockShell /></Suspense>
          } />
        )}
        {/* /create-identity now routes to the onboarding wizard. The
            legacy CreateIdentity page is preserved at /create-identity-legacy
            for fallback. */}
        <Route path="/create-identity" element={<Navigate to="/onboarding" replace />} />
        <Route path="/create-identity-legacy" element={<CreateIdentity />} />
        <Route
          path="/login"
          element={<Navigate to="/onboarding?mode=existing" replace />}
        />
        <Route path="/login-legacy" element={<Login />} />
        <Route path="/join/:token?" element={<InviteRedirect />} />
        <Route path="/join-legacy/:token?" element={<JoinTeam />} />
        <Route path="/recover" element={<RecoverFromServer />} />
        <Route path="/setup" element={<Navigate to="/onboarding?mode=bootstrap" replace />} />
        <Route path="/setup-legacy" element={<SetupAdmin />} />
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/app" element={<AppPage />} />
        <Route path="/app/channels/:channelId" element={<AppPage />} />
        <Route path="/app/settings" element={<TeamSettings />} />
        <Route path="/app/user-settings" element={<UserSettings />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
      </BrowserRouter>
    </ToastProvider>
    </ErrorBoundary>
  );
}

export default App;
