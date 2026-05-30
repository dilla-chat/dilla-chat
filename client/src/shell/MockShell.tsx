// /mesh — the demo path. Activates mock services, drives the same load
// hooks as /app, and renders the shared AppShell.

import AppShell from './AppShell';
import { useEagerLoad } from './useEagerLoad';
import { useTeamStore } from '../stores/teamStore';
import { useTeamSync } from '../hooks/useTeamSync';
import { ensureMockSession } from '../services/mockSession';

ensureMockSession();

export default function MockShell() {
  const activeTeamId = useTeamStore((s) => s.activeTeamId);
  useTeamSync(activeTeamId);
  const { ready } = useEagerLoad(activeTeamId);
  return <AppShell ready={ready} />;
}
