import { useEffect } from 'react';
import { useUserSettingsStore } from '../stores/userSettingsStore';

/**
 * Bridges userSettingsStore preferences to the document root so they
 * actually take effect:
 *
 *   - baseFontPx → html { font-size: <px>px } so all rem-based UI scales.
 *   - reduceMotion → html[data-reduce-motion="true"] for CSS to opt out
 *     of animations.
 *
 * Mount this once near the app root.
 */
export function useApplyUIPreferences(): void {
  const baseFontPx = useUserSettingsStore((s) => s.baseFontPx);
  const reduceMotion = useUserSettingsStore((s) => s.reduceMotion);

  useEffect(() => {
    document.documentElement.style.fontSize = `${baseFontPx}px`;
    return () => {
      // Don't revert on unmount — the preference is global. The cleanup
      // exists purely so React's hot-reload doesn't strand the override
      // on a stale value.
    };
  }, [baseFontPx]);

  useEffect(() => {
    if (reduceMotion) {
      document.documentElement.dataset.reduceMotion = 'true';
    } else {
      delete document.documentElement.dataset.reduceMotion;
    }
  }, [reduceMotion]);
}
