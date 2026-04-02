import { useEffect } from 'react';

/**
 * Loads a custom theme CSS file from the server if one is configured.
 * The link tag is inserted into <head> so custom :root vars override defaults.
 */
export function useCustomTheme(): void {
  useEffect(() => {
    let link: HTMLLinkElement | null = null;

    fetch('/api/v1/config')
      .then((res) => res.json())
      .then((data: { has_custom_theme?: boolean }) => {
        if (data?.has_custom_theme) {
          link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = '/theme/custom.css';
          link.dataset.customTheme = 'true';
          document.head.appendChild(link);
        }
      })
      .catch(() => {
        // No custom theme — silent fallback
      });

    return () => {
      if (link) {
        link.remove();
      }
    };
  }, []);
}
