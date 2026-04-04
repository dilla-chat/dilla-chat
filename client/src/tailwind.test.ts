import { describe, it, expect, beforeEach } from 'vitest';
import { useUserSettingsStore } from './stores/userSettingsStore';
import { useThemeStore } from './stores/themeStore';
import { darkTheme, lightTheme, minimalTheme } from './themes/themes';

beforeEach(() => {
  useUserSettingsStore.setState({ theme: 'dark' });
  useThemeStore.setState({ theme: 'dark' });
});

describe('Tailwind CSS integration', () => {
  it('theme CSS variables are set on document root for Tailwind @theme to reference', () => {
    const root = document.documentElement;
    // Tailwind @theme references var(--bg-primary), var(--text-normal), etc.
    // These are set by themeStore via applyTheme()
    expect(root.style.getPropertyValue('--bg-primary')).toBe(darkTheme['--bg-primary']);
    expect(root.style.getPropertyValue('--text-normal')).toBe(darkTheme['--text-normal']);
    expect(root.style.getPropertyValue('--brand-500')).toBe(darkTheme['--brand-500']);
    expect(root.style.getPropertyValue('--accent')).toBe(darkTheme['--accent']);
  });

  it('switching to light theme updates all CSS variables', () => {
    useUserSettingsStore.getState().setTheme('light');
    const root = document.documentElement;
    expect(root.style.getPropertyValue('--bg-primary')).toBe(lightTheme['--bg-primary']);
    expect(root.style.getPropertyValue('--text-normal')).toBe(lightTheme['--text-normal']);
    expect(root.style.getPropertyValue('--brand-500')).toBe(lightTheme['--brand-500']);
  });

  it('switching to minimal theme updates all CSS variables', () => {
    useUserSettingsStore.getState().setTheme('minimal');
    const root = document.documentElement;
    expect(root.style.getPropertyValue('--bg-primary')).toBe(minimalTheme['--bg-primary']);
    expect(root.style.getPropertyValue('--text-normal')).toBe(minimalTheme['--text-normal']);
  });

  it('all three themes define the same set of CSS variables', () => {
    const darkKeys = Object.keys(darkTheme).sort();
    const lightKeys = Object.keys(lightTheme).sort();
    const minimalKeys = Object.keys(minimalTheme).sort();
    expect(darkKeys).toEqual(lightKeys);
    expect(darkKeys).toEqual(minimalKeys);
  });

  it('all theme variables start with -- prefix', () => {
    for (const key of Object.keys(darkTheme)) {
      expect(key.startsWith('--')).toBe(true);
    }
  });

  it('critical Tailwind-referenced variables exist in themes', () => {
    // These are the CSS variables referenced in index.css @theme
    const requiredVars = [
      '--bg-primary',
      '--bg-secondary',
      '--bg-tertiary',
      '--bg-floating',
      '--bg-modifier-hover',
      '--bg-modifier-active',
      '--bg-modifier-selected',
      '--text-normal',
      '--text-primary',
      '--text-secondary',
      '--text-muted',
      '--text-link',
      '--text-danger',
      '--text-positive',
      '--text-warning',
      '--header-primary',
      '--header-secondary',
      '--brand-500',
      '--brand-560',
      '--accent',
      '--accent-hover',
      '--danger',
      '--success',
      '--warning',
      '--border-color',
      '--border-subtle',
      '--divider',
      '--interactive-normal',
      '--interactive-hover',
      '--interactive-active',
      '--interactive-muted',
      '--channel-icon',
      '--status-online',
      '--status-idle',
      '--status-dnd',
      '--status-offline',
      '--input-bg',
      '--modal-bg',
      '--glass-bg-primary',
      '--glass-bg-secondary',
      '--glass-bg-tertiary',
      '--glass-bg-floating',
      '--glass-bg-modal',
      '--glass-border',
      '--glass-border-light',
      '--glass-highlight',
      '--overlay-dark',
      '--overlay-light',
      '--overlay-heavy',
    ];

    for (const varName of requiredVars) {
      expect(darkTheme).toHaveProperty(varName);
      expect(lightTheme).toHaveProperty(varName);
      expect(minimalTheme).toHaveProperty(varName);
    }
  });

  it('theme switching preserves data-theme attribute', () => {
    expect(document.documentElement.dataset.theme).toBe('dark');

    useUserSettingsStore.getState().setTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');

    useUserSettingsStore.getState().setTheme('minimal');
    expect(document.documentElement.dataset.theme).toBe('minimal');

    useUserSettingsStore.getState().setTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('color scheme is set correctly for each theme', () => {
    useUserSettingsStore.getState().setTheme('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');

    useUserSettingsStore.getState().setTheme('light');
    expect(document.documentElement.style.colorScheme).toBe('light');

    useUserSettingsStore.getState().setTheme('minimal');
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });
});
