import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore, restoreDerivedKey, restorePassphrase } from '../stores/authStore';
import { initCrypto, isCryptoInitialized } from '../services/crypto';
import { unlockWithPrf, unlockWithPassphrase, hasPasskeyKeySlot, hasPasswordSlot } from '../services/keyStore';
import { fromBase64 } from '../services/cryptoCore';

/**
 * Re-initializes CryptoManager from a persisted derivedKey on mount.
 * First restores the encrypted derivedKey from sessionStorage, then
 * unlocks the identity and initializes the crypto manager.
 * Returns `cryptoReady` — true once sessions are fully restored.
 *
 * Two unlock paths exist depending on how the identity was created:
 * - Passkey users: derivedKey = raw PRF output bytes (base64-wrapped).
 *   Identity key file has `key_slots[]` populated.
 * - Passphrase users: derivedKey = UTF-8 bytes of the passphrase prefix
 *   (base64-wrapped). Identity key file has `password_slots[]`. The raw
 *   passphrase is recoverable from those bytes for the PBKDF2 derivation
 *   that wrapMekWithPassphrase performs per-slot.
 */
export function useCryptoRestore(): { cryptoReady: boolean } {
  const { derivedKey, setDerivedKey } = useAuthStore();
  const cryptoRestored = useRef(false);
  const [cryptoReady, setCryptoReady] = useState(false);
  const navigate = useNavigate();

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
        // Login (Onboarding existing-identity unlock flow) calls initCrypto
        // before navigating to /app, so the crypto manager is often already
        // live by the time this hook runs. Skip the re-init dance in that
        // case — calling initCrypto a second time is a no-op anyway, but
        // doing the slot probe would otherwise unconditionally bounce
        // passphrase users back to /login in a loop.
        if (isCryptoInitialized()) {
          console.log('[CryptoRestore] crypto already initialized, skipping restore');
          return;
        }
        const rawKey = fromBase64(derivedKey);
        const hasPrf = await hasPasskeyKeySlot();
        const hasPassword = await hasPasswordSlot();
        if (hasPrf) {
          // Passkey users: rawKey is the PRF output that derives the AES
          // wrapping key. This branch is silent on success.
          const identity = await unlockWithPrf(rawKey);
          await initCrypto(identity, derivedKey);
          console.log('[CryptoRestore] CryptoManager re-initialized from persisted derivedKey');
        } else if (hasPassword) {
          // Passphrase users: pull the passphrase from the per-tab
          // encrypted sessionStorage slot (set by Onboarding when the
          // user unlocks). If it's there, run unlockWithPassphrase —
          // PBKDF2 with the slot's salt+iterations recovers the MEK.
          // If it's missing (e.g., new tab or first visit), bounce to
          // /login so the user can re-enter it.
          const passphrase = await restorePassphrase();
          if (!passphrase) {
            console.warn('[CryptoRestore] No persisted passphrase — redirecting to /login');
            navigate('/login');
            return;
          }
          try {
            const identity = await unlockWithPassphrase(passphrase);
            await initCrypto(identity, derivedKey);
            console.log('[CryptoRestore] CryptoManager re-initialized from persisted passphrase');
          } catch (err) {
            console.warn('[CryptoRestore] Persisted passphrase rejected — redirecting to /login', err);
            navigate('/login');
            return;
          }
        } else {
          throw new Error('Identity has neither passkey nor passphrase slot');
        }
      } catch (e) {
        console.warn('[CryptoRestore] Failed to re-init crypto:', e);
      } finally {
        setCryptoReady(true);
      }
    })();
  }, [derivedKey, navigate]);

  return { cryptoReady };
}
