import { useEffect, useRef, useState } from 'react';
import { useAuthStore, restoreDerivedKey } from '../stores/authStore';
import { initCrypto } from '../services/crypto';
import { unlockWithPrf } from '../services/keyStore';
import { fromBase64 } from '../services/cryptoCore';

/**
 * Re-initializes CryptoManager from a persisted derivedKey on mount.
 * First restores the encrypted derivedKey from sessionStorage, then
 * unlocks the identity and initializes the crypto manager.
 * Returns `cryptoReady` — true once sessions are fully restored.
 */
export function useCryptoRestore(): { cryptoReady: boolean } {
  const { derivedKey, setDerivedKey } = useAuthStore();
  const cryptoRestored = useRef(false);
  const [cryptoReady, setCryptoReady] = useState(false);

  // Async restore of encrypted derivedKey from sessionStorage
  useEffect(() => {
    if (derivedKey || cryptoRestored.current) return;
    (async () => {
      const restored = await restoreDerivedKey();
      if (restored) {
        setDerivedKey(restored);
      } else {
        setCryptoReady(true);
      }
    })();
  }, [derivedKey, setDerivedKey]);

  // Once derivedKey is available, init crypto
  useEffect(() => {
    if (cryptoRestored.current || !derivedKey) return;
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
