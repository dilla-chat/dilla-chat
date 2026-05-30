import { describe, it, expect, beforeEach } from 'vitest';
import { useUserSettingsStore } from './userSettingsStore';
// Import themeStore to trigger subscription
import { useThemeStore } from './themeStore';

beforeEach(() => {
  useUserSettingsStore.setState({ theme: 'dark', density: 'regular' });
  useThemeStore.setState({ theme: 'dark' });
  document.documentElement.dataset.density = 'regular';
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

  it('syncs when userSettingsStore theme changes to mesh', () => {
    useUserSettingsStore.getState().setTheme('mesh');
    expect(useThemeStore.getState().theme).toBe('mesh');
    expect(document.documentElement.dataset.theme).toBe('mesh');
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  it('applies mesh-native tokens when mesh theme selected', () => {
    useUserSettingsStore.getState().setTheme('mesh');
    const root = document.documentElement;
    expect(root.style.getPropertyValue('--bg')).toBe('#070809');
    expect(root.style.getPropertyValue('--accent')).toBe('#7CFF8E');
    expect(root.style.getPropertyValue('--fg')).toBe('#E8ECE8');
    // Legacy tokens get repointed to Mesh equivalents
    expect(root.style.getPropertyValue('--bg-primary')).toBe('#070809');
    expect(root.style.getPropertyValue('--text-primary')).toBe('#E8ECE8');
  });

  it('applies density as data-density on <html>', () => {
    useUserSettingsStore.getState().setDensity('compact');
    expect(document.documentElement.dataset.density).toBe('compact');
    useUserSettingsStore.getState().setDensity('cozy');
    expect(document.documentElement.dataset.density).toBe('cozy');
    useUserSettingsStore.getState().setDensity('regular');
    expect(document.documentElement.dataset.density).toBe('regular');
  });
});
