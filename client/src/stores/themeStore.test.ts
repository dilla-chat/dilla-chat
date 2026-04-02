import { describe, it, expect, beforeEach } from 'vitest';
import { useUserSettingsStore } from './userSettingsStore';
// Import themeStore to trigger subscription
import { useThemeStore } from './themeStore';

beforeEach(() => {
  useUserSettingsStore.setState({ theme: 'dark' });
  useThemeStore.setState({ theme: 'dark' });
});

describe('themeStore', () => {
  it('applies CSS variables to document.documentElement', () => {
    // Theme store applies on creation — check that data-theme is set
    const root = document.documentElement;
    expect(root.dataset.theme).toBe('dark');
  });

  it('syncs when userSettingsStore theme changes to light', () => {
    useUserSettingsStore.getState().setTheme('light');
    expect(useThemeStore.getState().theme).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  it('syncs when userSettingsStore theme changes to minimal', () => {
    useUserSettingsStore.getState().setTheme('minimal');
    expect(useThemeStore.getState().theme).toBe('minimal');
    expect(document.documentElement.dataset.theme).toBe('minimal');
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  it('applies minimal theme CSS variables', () => {
    useUserSettingsStore.getState().setTheme('minimal');
    const root = document.documentElement;
    // Minimal theme uses neutral grays
    expect(root.style.getPropertyValue('--bg-primary')).toBeTruthy();
  });
});
