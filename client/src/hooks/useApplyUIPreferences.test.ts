import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useApplyUIPreferences } from './useApplyUIPreferences';
import { useUserSettingsStore } from '../stores/userSettingsStore';

describe('useApplyUIPreferences', () => {
  beforeEach(() => {
    document.documentElement.style.fontSize = '';
    document.documentElement.removeAttribute('data-reduce-motion');
    useUserSettingsStore.setState({ baseFontPx: 16, reduceMotion: false });
  });

  it('sets html font-size to match baseFontPx', () => {
    useUserSettingsStore.setState({ baseFontPx: 18 });
    renderHook(() => useApplyUIPreferences());
    expect(document.documentElement.style.fontSize).toBe('18px');
  });

  it('updates the html font-size when baseFontPx changes', () => {
    const { rerender } = renderHook(() => useApplyUIPreferences());
    useUserSettingsStore.setState({ baseFontPx: 20 });
    rerender();
    expect(document.documentElement.style.fontSize).toBe('20px');
  });

  it('sets data-reduce-motion="true" when reduceMotion is on', () => {
    useUserSettingsStore.setState({ reduceMotion: true });
    renderHook(() => useApplyUIPreferences());
    expect(document.documentElement.getAttribute('data-reduce-motion')).toBe('true');
  });

  it('removes data-reduce-motion when reduceMotion is off', () => {
    document.documentElement.setAttribute('data-reduce-motion', 'true');
    useUserSettingsStore.setState({ reduceMotion: false });
    renderHook(() => useApplyUIPreferences());
    expect(document.documentElement.hasAttribute('data-reduce-motion')).toBe(false);
  });

  it('toggling reduceMotion mid-flight flips the attribute', () => {
    const { rerender } = renderHook(() => useApplyUIPreferences());
    useUserSettingsStore.setState({ reduceMotion: true });
    rerender();
    expect(document.documentElement.getAttribute('data-reduce-motion')).toBe('true');
    useUserSettingsStore.setState({ reduceMotion: false });
    rerender();
    expect(document.documentElement.hasAttribute('data-reduce-motion')).toBe(false);
  });
});
