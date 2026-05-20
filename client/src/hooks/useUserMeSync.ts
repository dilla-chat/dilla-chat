// Pull server-backed user preferences (quiet hours, etc.) into the local
// userSettingsStore once auth is ready. Without this, the Settings form
// would show the store's hardcoded defaults instead of whatever the user
// previously saved on another device.
//
// Keeps it lightweight — single GET per activeTeam change. Updates flow
// the other way via PATCH /users/me in the field handlers.

import { useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useUserSettingsStore } from '../stores/userSettingsStore';
import { api } from '../services/api';

export function useUserMeSync(activeTeamId: string | null): void {
  const teams = useAuthStore((s) => s.teams);
  useEffect(() => {
    if (!activeTeamId) return;
    const auth = teams.get(activeTeamId);
    if (!auth?.baseUrl || !auth.token) return;
    let cancelled = false;
    api
      .getMe(auth.baseUrl, auth.token)
      .then((me) => {
        if (cancelled || !me || typeof me !== 'object') return;
        const m = me as Record<string, unknown>;
        useUserSettingsStore.getState().setQuietHours({
          enabled: typeof m.quiet_hours_enabled === 'boolean' ? m.quiet_hours_enabled : undefined,
          from: typeof m.quiet_hours_from === 'string' && m.quiet_hours_from ? m.quiet_hours_from : undefined,
          to: typeof m.quiet_hours_to === 'string' && m.quiet_hours_to ? m.quiet_hours_to : undefined,
        });
      })
      .catch((err) => console.warn('[useUserMeSync] getMe failed', err));
    return () => { cancelled = true; };
  }, [activeTeamId, teams]);
}
