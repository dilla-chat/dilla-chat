// /app/user-settings — redirect-to-modal shim. Same pattern as
// pages/TeamSettings.tsx: mesh redesign moved User Settings into the
// shell modal (shell/Settings.tsx). PasskeyManager — the one bit the
// old route had that the modal lacked — was ported into UserPrivacy
// in the same change. Route stays for bookmarks + the legacy
// AppLayout's UserPanel navigate call.

import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

export default function UserSettings() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  useEffect(() => {
    const tab = params.get('tab');
    globalThis.dispatchEvent(
      new CustomEvent('dilla:open-settings', {
        detail: { mode: 'user', tab: tab || null },
      }),
    );
    navigate('/app', { replace: true });
  }, [navigate, params]);
  return null;
}
