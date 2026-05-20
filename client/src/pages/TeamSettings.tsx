// /app/settings — redirect-to-modal shim. The mesh redesign moved Team
// Settings into the in-shell modal (shell/Settings.tsx). The route URL
// stays for bookmarks and the legacy AppLayout/TeamSidebar code paths;
// landing here fires the same dilla:open-settings event the gear icon
// does, then bounces back to /app so the address bar isn't stuck on a
// meaningless URL.
//
// The old pages/TeamSettings/ tree (Overview/Roles/Members/Invites/
// Integrations/Federation/Moderation/Audit/Bans tabs) is left in place
// for the moment so the file moves stay small — but it's no longer
// imported by anything. Safe to delete in a follow-up.

import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

export default function TeamSettings() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  useEffect(() => {
    const tab = params.get('tab');
    window.dispatchEvent(
      new CustomEvent('dilla:open-settings', {
        detail: { mode: 'team', tab: tab || null },
      }),
    );
    navigate('/app', { replace: true });
  }, [navigate, params]);
  return null;
}
