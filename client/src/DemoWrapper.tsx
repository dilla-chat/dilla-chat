// /demo wrapper — activates the mock api+ws services, then mounts the
// real AppLayout. From here the standard load flow drives everything:
// useTeamSync issues sync:init via the mock ws, the mock returns the demo
// snapshot, and stores populate exactly as they would in prod.

import { ensureMockSession } from './services/mockSession';
import AppLayout from './pages/AppLayout';

ensureMockSession();

export default function DemoWrapper() {
  return <AppLayout />;
}
