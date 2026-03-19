import { useEffect, useRef, type MutableRefObject } from 'react';
import { useAuthStore } from '../stores/authStore';
import { api } from '../services/api';

/**
 * Uploads the identity blob to all servers once per session for cross-device recovery.
 */
export function useIdentityBackup(
  activeTeamId: string | null,
  dataLoaded: MutableRefObject<Set<string>>,
): void {
  const { teams, derivedKey } = useAuthStore();
  const blobUploaded = useRef(false);

  useEffect(() => {
    if (blobUploaded.current || !activeTeamId || !derivedKey) return;
    if (!dataLoaded.current.has(activeTeamId)) return;
    blobUploaded.current = true;

    (async () => {
      try {
        const { exportIdentityBlob } = await import('../services/keyStore');
        const blob = await exportIdentityBlob();
        if (!blob) return;
        const allServers: string[] = [];
        teams.forEach((entry) => {
          if (entry.baseUrl) allServers.push(entry.baseUrl);
        });
        for (const [teamId, entry] of teams) {
          const { baseUrl, token } = entry;
          if (!baseUrl || !token) continue;
          const jwt = api.getConnectionInfo(teamId)?.token || token;
          try {
            await fetch(`${baseUrl}/api/v1/identity/blob`, {
              method: 'PUT',
              headers: { 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ blob, servers: allServers }),
            });
            console.log(`[AppLayout] Identity blob uploaded to ${baseUrl}`);
          } catch (e) {
            console.warn(`[AppLayout] Blob upload to ${baseUrl} failed:`, e);
          }
        }
      } catch (e) {
        console.warn('[AppLayout] Blob upload skipped:', e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- blob upload runs once per session; teams is read inside the async closure
  }, [activeTeamId, derivedKey, dataLoaded.current.size]);
}
