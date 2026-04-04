import { useEffect, useRef, type RefObject } from 'react';
import { createFocusTrap, type FocusTrap } from 'focus-trap';

export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
  onEscape?: () => void,
): void {
  const trapRef = useRef<FocusTrap | null>(null);

  useEffect(() => {
    if (!active || !containerRef.current) return;

    const trap = createFocusTrap(containerRef.current, {
      escapeDeactivates: !!onEscape,
      onDeactivate: onEscape,
      allowOutsideClick: true,
      fallbackFocus: containerRef.current,
    });

    trap.activate();
    trapRef.current = trap;

    return () => {
      // Pass a noop onDeactivate to prevent firing onClose during
      // React StrictMode cleanup (which double-invokes effects).
      trap.deactivate({ onDeactivate: () => {} });
      trapRef.current = null;
    };
  }, [active, containerRef, onEscape]);
}
