import { useCallback, useEffect, useState } from 'react';
import { cryptoService } from '../services/crypto';
import { api } from '../services/api';
import type { ServerStatus } from '../components/ServerAddressInput/ServerAddressInput';

/**
 * Normalize a user-entered server address to a full URL.
 */
export function normalizeServerUrl(address: string): string {
  const trimmed = address.trim().replace(/\/$/, '');
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/**
 * Hook that checks server health with debounced polling when the address changes.
 */
export function useServerHealthCheck(
  serverAddress: string,
  initialStatus: ServerStatus = 'unknown',
): [ServerStatus, React.Dispatch<React.SetStateAction<ServerStatus>>] {
  const [serverStatus, setServerStatus] = useState<ServerStatus>(initialStatus);

  const checkServer = useCallback(async (address: string) => {
    if (!address.trim()) {
      setServerStatus('unknown');
      return;
    }
    setServerStatus('checking');
    try {
      const url = normalizeServerUrl(address);
      const res = await fetch(`${url}/api/v1/health`, { signal: AbortSignal.timeout(5000) });
      setServerStatus(res.ok ? 'online' : 'offline');
    } catch {
      setServerStatus('offline');
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => checkServer(serverAddress), 500);
    return () => clearTimeout(timer);
  }, [serverAddress, checkServer]);

  return [serverStatus, setServerStatus];
}

/**
 * Upload a prekey bundle for E2E encryption (non-blocking, logs warnings on failure).
 */
export async function uploadPrekeyBundle(derivedKey: string, teamId: string): Promise<void> {
  try {
    const bundle = await cryptoService.generatePrekeyBundle(derivedKey);
    const toB64 = (arr: number[]) => btoa(String.fromCodePoint(...arr));
    await api.uploadPrekeyBundle(teamId, {
      identity_key: toB64(bundle.identity_key),
      signed_prekey: toB64(bundle.signed_prekey),
      signed_prekey_signature: toB64(bundle.signed_prekey_signature),
      one_time_prekeys: bundle.one_time_prekeys.map(toB64),
    });
  } catch (e) {
    console.warn('Prekey upload failed:', e);
  }
}

/**
 * Set the active team and navigate to the app. Dynamically imports teamStore to avoid circular deps.
 */
export async function activateTeamAndNavigate(
  teamId: string,
  navigate: (path: string) => void,
): Promise<void> {
  const { useTeamStore } = await import('../stores/teamStore');
  useTeamStore.getState().setActiveTeam(teamId);
  navigate('/app');
}
