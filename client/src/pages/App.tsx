// /app — production entry. Sets up the auth/crypto/sync chain and renders
// the shared AppShell. Channels arrive via the real useTeamSync flow;
// per-channel data is eager-loaded so ChatApp's captured snapshot is
// populated on first render (until ChatApp can be decomposed into reactive
// components, eager-load is the cheapest fix).

import { useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import AppShell from '../shell/AppShell';
import { useEagerLoad } from '../shell/useEagerLoad';
import { useTeamStore } from '../stores/teamStore';
import { useAuthStore } from '../stores/authStore';
import { useTeamSync } from '../hooks/useTeamSync';
import { useUserMeSync } from '../hooks/useUserMeSync';
import { useCryptoRestore } from '../hooks/useCryptoRestore';
import { useIdentityBackup } from '../hooks/useIdentityBackup';
import { usePrekeyBackfill } from '../hooks/usePrekeyBackfill';
import { usePresenceEvents } from '../hooks/usePresenceEvents';
import { useCustomTheme } from '../hooks/useCustomTheme';
import { useApplyUIPreferences } from '../hooks/useApplyUIPreferences';
import { useShellSync } from '../hooks/useShellSync';
import { useChannelEvents } from '../hooks/useChannelEvents';
import { useDMEvents } from '../hooks/useDMEvents';
import { useThreadEvents } from '../hooks/useThreadEvents';
import { telemetryClient } from '../services/telemetryClient';

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const activeTeamId = useTeamStore((s) => s.activeTeamId);
  const authTeams = useAuthStore((s) => s.teams);

  useCustomTheme();
  useApplyUIPreferences();
  useShellSync();
  const { cryptoReady } = useCryptoRestore();
  const { authChecked, dataLoaded } = useTeamSync(activeTeamId);
  useUserMeSync(activeTeamId);
  useIdentityBackup(activeTeamId, dataLoaded);
  usePrekeyBackfill(activeTeamId, dataLoaded, cryptoReady);
  usePresenceEvents(activeTeamId);
  useChannelEvents(activeTeamId, cryptoReady);
  useDMEvents(activeTeamId, cryptoReady);
  useThreadEvents(activeTeamId);
  const { ready: eagerReady } = useEagerLoad(activeTeamId, cryptoReady);

  // Redirect to join/setup if no teams — wait until auth is validated so we
  // don't redirect during the brief window before persisted state is confirmed.
  useEffect(() => {
    if (authChecked && authTeams.size === 0) {
      navigate('/join');
    }
  }, [authTeams, navigate, authChecked]);

  // Install global error handlers for telemetry once.
  useEffect(() => {
    telemetryClient.install();
  }, []);

  // Record route changes as telemetry breadcrumbs.
  useEffect(() => {
    telemetryClient.addBreadcrumb('navigation', location.pathname);
  }, [location.pathname]);

  if (!authChecked || !cryptoReady) return null;

  return <AppShell ready={eagerReady} />;
}
