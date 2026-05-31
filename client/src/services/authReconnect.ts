import { api, isSameOriginAsApi } from './api';
import { useAuthStore, type TeamEntry } from '../stores/authStore';
import { getIdentityKeys } from './crypto';
import {
  exportIdentityBlob,
  signChallenge,
  hasPasskeyKeySlot,
  listEscrowableCredentialDescriptors,
  buildRecoveryEscrowBlob,
} from './keyStore';
import { fromBase64, toBase64 } from './cryptoCore';

async function reAuthenticateOneTeam(
  teamId: string,
  entry: TeamEntry,
  pubKey: string,
  signingKey: CryptoKey,
): Promise<boolean> {
  const baseUrl = entry.baseUrl;
  if (!baseUrl) return false;
  try {
    api.addTeam(teamId, baseUrl);
    const { challenge_id, nonce } = await api.requestChallenge(teamId, pubKey);
    const nonceBytes = fromBase64(nonce);
    const sigBytes = await signChallenge(signingKey, nonceBytes);
    const signature = toBase64(sigBytes);
    const result = await api.verifyChallenge(teamId, challenge_id, pubKey, signature);
    api.setToken(teamId, result.token);
    const { addTeam: updateTeam } = useAuthStore.getState();
    updateTeam(teamId, result.token, entry.user, entry.teamInfo, baseUrl);
    return true;
  } catch (err) {
    console.error(`[authReconnect] refresh failed for team ${teamId}:`, err);
    const { removeTeam } = useAuthStore.getState();
    removeTeam(teamId);
    api.removeTeam(teamId);
    return false;
  }
}

async function uploadIdentityBlobToTeam(
  _teamId: string,
  baseUrl: string,
  token: string,
  blob: string,
  allServers: string[],
): Promise<void> {
  try {
    // H-13d: bearer header only when not same-origin (Tauri /
    // cross-origin still needs it; same-origin SPA rides the
    // cookie alone).
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (!isSameOriginAsApi(baseUrl)) {
      headers.Authorization = `Bearer ${token}`;
    }
    await fetch(`${baseUrl}/api/v1/identity/blob`, {
      method: 'PUT',
      headers,
      credentials: 'include',
      body: JSON.stringify({ blob, servers: allServers }),
    });
  } catch {
    // Blob upload failure is non-fatal
  }
}

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
    if (await reAuthenticateOneTeam(teamId, entry, pubKey, keys.signingKey)) {
      successCount++;
    }
  }

  // Upload identity blob to all servers for cross-device recovery.
  const blob = await exportIdentityBlob();
  if (blob) {
    const allServers: string[] = [...useAuthStore.getState().teams.values()]
      .map(e => e.baseUrl)
      .filter((url): url is string => Boolean(url));
    for (const [teamId] of useAuthStore.getState().teams) {
      const freshEntry = useAuthStore.getState().teams.get(teamId);
      const baseUrl = freshEntry?.baseUrl;
      const token = freshEntry?.token;
      if (!baseUrl || !token) continue;
      await uploadIdentityBlobToTeam(teamId, baseUrl, token, blob, allServers);
    }
  }

  // Passkey-recoverable identity escrow (design doc 15). Only relevant
  // for passkey users — passphrase users keep using the recovery-key
  // path above. Best-effort, failures are silent so a server that
  // hasn't shipped the migration yet doesn't break login.
  await uploadPasskeyRecoverySlots().catch((err) => {
    console.debug('[authReconnect] passkey recovery escrow skipped:', err);
  });

  return successCount;
}

/** Opportunistically escrow the passkey-recoverable copy of
 *  identity.key on every connected server. Idempotent on
 *  (user_id, credential_id) — the server upsert refreshes the blob
 *  when the contents change.
 *
 *  Skips silently when:
 *  - no passkey slot exists (passphrase-only user → recovery-key path
 *    is their only option)
 *  - the in-memory derivedKey isn't available (lock screen / fresh
 *    reload before crypto reinit completes)
 *  - the server returns a 4xx/5xx (older nightly without the recovery
 *    endpoint yet, or rate-limited) */
async function uploadPasskeyRecoverySlots(): Promise<void> {
  if (!(await hasPasskeyKeySlot())) return;
  const derivedKeyB64 = useAuthStore.getState().derivedKey;
  if (!derivedKeyB64) return;
  const prfOutput = fromBase64(derivedKeyB64);
  const descriptors = await listEscrowableCredentialDescriptors();
  if (descriptors.length === 0) return;
  // The whole blob is the same regardless of credential — the server
  // stores one copy per credential because each has its own PRF salt
  // and re-derives a (potentially) different wrap key.
  const encryptedBlob = await buildRecoveryEscrowBlob(prfOutput);
  const encryptedBlobB64 = toBase64(encryptedBlob);
  for (const [teamId] of useAuthStore.getState().teams) {
    const entry = useAuthStore.getState().teams.get(teamId);
    if (!entry?.token) continue;
    for (const desc of descriptors) {
      try {
        await api.uploadRecoverySlot(teamId, {
          credential_id: desc.credentialId,
          prf_salt: toBase64(desc.prfSalt),
          encrypted_blob: encryptedBlobB64,
        });
      } catch (err) {
        // Best-effort — log at debug so this doesn't spam regular use.
        console.debug(
          `[authReconnect] recovery escrow upload failed for team ${teamId} credential ${desc.credentialId}:`,
          err,
        );
      }
    }
  }
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
