// /mesh — the demo path. Activates mock services, drives the same load
// hooks as /app, and renders the shared MeshApp shell.

import MeshApp from './MeshApp';
import { useMeshEagerLoad } from './useMeshEagerLoad';
import { useTeamStore } from '../../stores/teamStore';
import { useTeamSync } from '../../hooks/useTeamSync';
import { ensureMockSession } from '../../services/mockSession';

ensureMockSession();

export default function MeshSandbox() {
  const activeTeamId = useTeamStore((s) => s.activeTeamId);
  useTeamSync(activeTeamId);
  const { ready } = useMeshEagerLoad(activeTeamId);
  return <MeshApp ready={ready} />;
}
