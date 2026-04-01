import { Component, type ReactNode, useEffect, useState, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './stores/authStore';
import { recordException } from './services/telemetry';
import './i18n';
import './App.css';

import CreateIdentity from './pages/CreateIdentity';
import Login from './pages/Login';
import JoinTeam from './pages/JoinTeam';
import RecoverFromServer from './pages/RecoverFromServer';
import SetupAdmin from './pages/SetupAdmin';
import AppLayout from './pages/AppLayout';
import TeamSettings from './pages/TeamSettings';
import UserSettings from './pages/UserSettings';
import NotFound from './pages/NotFound';
import { ToastProvider } from './components/Toast/Toast';
// useToast hook available from './components/Toast/useToast' for consumer components

const DEMO_ENABLED = import.meta.env.VITE_DEMO === 'true';

// Lazy-load demo wrapper only when VITE_DEMO=true
const DemoWrapper = DEMO_ENABLED
  ? lazy(() => import('./DemoWrapper'))
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
        setTarget(exists ? '/login' : '/create-identity');
      } catch {
        setTarget('/create-identity');
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
        {DEMO_ENABLED && (
          <Route path="/demo" element={
            <Suspense fallback={null}><DemoWrapper /></Suspense>
          } />
        )}
        <Route path="/create-identity" element={<CreateIdentity />} />
        <Route path="/login" element={<Login />} />
        <Route path="/join/:token?" element={<JoinTeam />} />
        <Route path="/recover" element={<RecoverFromServer />} />
        <Route path="/setup" element={<SetupAdmin />} />
        <Route path="/app" element={<AppLayout />} />
        <Route path="/app/channels/:channelId" element={<AppLayout />} />
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
