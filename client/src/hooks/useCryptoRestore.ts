import { useEffect, useRef } from 'react';
import { useAuthStore } from '../stores/authStore';
import { initCrypto } from '../services/crypto';
import { unlockWithPrf } from '../services/keyStore';
import { fromBase64 } from '../services/cryptoCore';

/**
 * Re-initializes CryptoManager from a persisted derivedKey on mount.
 */
export function useCryptoRestore(): void {
  const { derivedKey } = useAuthStore();
  const cryptoRestored = useRef(false);

  useEffect(() => {
    if (cryptoRestored.current || !derivedKey) return;
    cryptoRestored.current = true;

    (async () => {
      try {
        const prfKey = fromBase64(derivedKey);
        const identity = await unlockWithPrf(prfKey);
        await initCrypto(identity, derivedKey);
        console.log('[AppLayout] CryptoManager re-initialized from persisted derivedKey');
      } catch (e) {
        console.warn('[AppLayout] Failed to re-init crypto:', e);
      }
    })();
  }, [derivedKey]);
}
