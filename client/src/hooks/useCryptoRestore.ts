import { useEffect, useRef, useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import { initCrypto } from '../services/crypto';
import { unlockWithPrf } from '../services/keyStore';
import { fromBase64 } from '../services/cryptoCore';

/**
 * Re-initializes CryptoManager from a persisted derivedKey on mount.
 * Returns `cryptoReady` — true once sessions are fully restored from IndexedDB.
 */
export function useCryptoRestore(): { cryptoReady: boolean } {
  const { derivedKey } = useAuthStore();
  const cryptoRestored = useRef(false);
  const [cryptoReady, setCryptoReady] = useState(false);

  useEffect(() => {
    if (cryptoRestored.current || !derivedKey) {
      // If no derivedKey, crypto can't init but we shouldn't block forever
      if (!derivedKey) setCryptoReady(true);
      return;
    }
    cryptoRestored.current = true;

    (async () => {
      try {
        const prfKey = fromBase64(derivedKey);
        const identity = await unlockWithPrf(prfKey);
        await initCrypto(identity, derivedKey);
        console.log('[CryptoRestore] CryptoManager re-initialized from persisted derivedKey');
      } catch (e) {
        console.warn('[CryptoRestore] Failed to re-init crypto:', e);
      } finally {
        setCryptoReady(true);
      }
    })();
  }, [derivedKey]);

  return { cryptoReady };
}
