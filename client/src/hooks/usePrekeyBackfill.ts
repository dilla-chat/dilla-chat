import { useEffect, useRef, type RefObject } from 'react';
import { useAuthStore } from '../stores/authStore';
import { api } from '../services/api';
import { cryptoService } from '../services/crypto';
import { uploadPrekeyBundle } from '../utils/serverConnection';

/**
 * Ensure the active team's server has an up-to-date prekey bundle for
 * this user. Runs once per session after sync:init.
 *
 * Background: earlier client builds called `api.uploadPrekeyBundle`
 * with the wrong arguments — the request hit Vite's dev server instead
 * of the backend and the upload silently failed. Existing users
 * registered on those builds therefore have NO prekey bundle on the
 * server, which makes every X3DH session initiation by a peer fail
 * with `prekey bundle not found` (404). That blocks voice E2E key
 * distribution, DM session setup, and any other Signal Protocol
 * operation targeting them.
 *
 * Backfill on boot is cheap (the server uses INSERT OR REPLACE) and
 * fixes the cohort of users who registered on the buggy build without
 * requiring them to re-register.
 */
export function usePrekeyBackfill(
  activeTeamId: string | null,
  dataLoaded: RefObject<Set<string>>,
  cryptoReady: boolean,
): void {
  const { teams, derivedKey } = useAuthStore();
  const uploaded = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!activeTeamId || !derivedKey) return;
    if (!dataLoaded.current.has(activeTeamId)) return;
    // Wait for the CryptoManager to finish restoring before reading
    // hasPrekeySecrets() / calling generatePrekeyBundle(). Otherwise
    // the first call throws "Crypto not initialized" and the hook
    // bails before re-upload can happen.
    if (!cryptoReady) return;
    if (uploaded.current.has(activeTeamId)) return;
    uploaded.current.add(activeTeamId);

    const user = teams.get(activeTeamId)?.user;
    if (!user?.id) return;

    (async () => {
      try {
        // Re-upload if EITHER:
        //  (a) the server has no bundle for us (initial registration
        //      or after admin wipe), or
        //  (b) we have no local prekey secrets — happens after a
        //      session-format upgrade clears them. Without local
        //      privates we can't run x3dhRespond, and the server's
        //      published bundle would point at public keys whose
        //      matching privates we no longer have.
        const localHasSecrets = cryptoService.hasPrekeySecrets();
        let serverHasBundle = true;
        try {
          await api.getPrekeyBundle(activeTeamId, user.id);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('prekey bundle not found') || msg.includes('404')) {
            serverHasBundle = false;
          } else {
            console.warn('[Prekey] getPrekeyBundle failed (not a 404), skipping backfill:', msg);
            return;
          }
        }
        if (serverHasBundle && localHasSecrets) {
          return;
        }
        console.log(
          '[Prekey] regenerating bundle for',
          user.id,
          '— serverHasBundle=', serverHasBundle,
          'localHasSecrets=', localHasSecrets,
        );
        await uploadPrekeyBundle(derivedKey, activeTeamId);
      } catch (err) {
        console.warn('[Prekey] backfill failed:', err);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per active team per session
  }, [activeTeamId, derivedKey, dataLoaded.current.size, cryptoReady]);
}
