import { api } from './api';
import { useAuthStore, type TeamEntry } from '../stores/authStore';
import { getIdentityKeys } from './crypto';
import { exportIdentityBlob, signChallenge } from './keyStore';
import { fromBase64, toBase64 } from './cryptoCore';

/**
 * Re-authenticate with all persisted servers to get fresh JWT tokens.
 * Returns the number of teams successfully re-authenticated.
 */
export async function refreshServerTokens(
  teams: Map<string, TeamEntry>,
  pubKey: string,
): Promise<number> {
  const keys = getIdentityKeys();
  let successCount = 0;

  console.log(`[authReconnect] refreshing tokens for ${teams.size} teams`);
  for (const [teamId, entry] of teams) {
    const baseUrl = entry.baseUrl;
    if (!baseUrl) continue;

    try {
      api.addTeam(teamId, baseUrl);
      const { challenge_id, nonce } = await api.requestChallenge(teamId, pubKey);
      const nonceBytes = fromBase64(nonce);
      const sigBytes = await signChallenge(keys.signingKey, nonceBytes);
      const signature = toBase64(sigBytes);
      const result = await api.verifyChallenge(teamId, challenge_id, pubKey, signature);
      api.setToken(teamId, result.token);

      const { addTeam: updateTeam } = useAuthStore.getState();
      updateTeam(teamId, result.token, entry.user, entry.teamInfo, baseUrl);
      successCount++;
    } catch (err) {
      console.error(`[authReconnect] refresh failed for team ${teamId}:`, err);
      const { removeTeam } = useAuthStore.getState();
      removeTeam(teamId);
      api.removeTeam(teamId);
    }
  }

  // Upload identity blob to all servers for cross-device recovery
  const blob = await exportIdentityBlob();
  if (blob) {
    for (const [teamId, entry] of useAuthStore.getState().teams) {
      const baseUrl = entry.baseUrl;
      const freshEntry = useAuthStore.getState().teams.get(teamId);
      const token = freshEntry?.token;
      if (!baseUrl || !token) continue;

      const allServers: string[] = [...useAuthStore.getState().teams.values()]
        .map(e => e.baseUrl)
        .filter((url): url is string => Boolean(url));

      try {
        await fetch(`${baseUrl}/api/v1/identity/blob`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ blob, servers: allServers }),
        });
      } catch {
        // Blob upload failure is non-fatal
      }
    }
  }

  return successCount;
}

/**
 * Attempt to auto-reconnect to the current server by discovering teams.
 * Returns true if at least one team was discovered and added.
 */
export async function tryReconnectToCurrentServer(pubKey: string): Promise<boolean> {
  const keys = getIdentityKeys();
  const baseUrl = globalThis.window === undefined ? '' : globalThis.location.origin;
  const tempId = '__reconnect__';

  try {
    api.addTeam(tempId, baseUrl);
    console.log('[authReconnect] trying reconnect to', baseUrl, 'with pubKey', pubKey.slice(0, 20) + '...');
    const { challenge_id, nonce } = await api.requestChallenge(tempId, pubKey);
    const nonceBytes = fromBase64(nonce);
    const sigBytes = await signChallenge(keys.signingKey, nonceBytes);
    const signature = toBase64(sigBytes);
    const result = await api.verifyChallenge(tempId, challenge_id, pubKey, signature);
    console.log('[authReconnect] verify succeeded, listing teams');

    const serverTeams = await api.listTeams(baseUrl, result.token);
    api.removeTeam(tempId);

    if (!serverTeams || serverTeams.length === 0) {
      console.warn('[authReconnect] no teams found on server');
      return false;
    }

    const { addTeam: storeAddTeam } = useAuthStore.getState();
    for (const team of serverTeams) {
      const teamId = team.id as string | undefined;
      if (!teamId) continue;
      api.addTeam(teamId, baseUrl);
      api.setToken(teamId, result.token);
      storeAddTeam(teamId, result.token, result.user, team, baseUrl);
    }

    return useAuthStore.getState().teams.size > 0;
  } catch (err) {
    console.error('[authReconnect] reconnect failed:', err);
    api.removeTeam(tempId);
    return false;
  }
}
