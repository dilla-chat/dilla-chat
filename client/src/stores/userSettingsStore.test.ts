import { describe, it, expect, beforeEach } from 'vitest';
import { useUserSettingsStore } from './userSettingsStore';

function getState() {
  return useUserSettingsStore.getState();
}

beforeEach(() => {
  useUserSettingsStore.setState({
    selectedInputDevice: 'default',
    selectedOutputDevice: 'default',
    inputThreshold: 0.15,
    inputVolume: 1.0,
    outputVolume: 1.0,
    desktopNotifications: true,
    soundNotifications: true,
    theme: 'dark',
  });
});

describe('defaults', () => {
  it('has correct default values', () => {
    expect(getState().selectedInputDevice).toBe('default');
    expect(getState().theme).toBe('dark');
    expect(getState().desktopNotifications).toBe(true);
    expect(getState().inputVolume).toBe(1.0);
  });
});

describe('setters', () => {
  it('setSelectedInputDevice', () => {
    getState().setSelectedInputDevice('mic-1');
    expect(getState().selectedInputDevice).toBe('mic-1');
  });

  it('setTheme', () => {
    getState().setTheme('light');
    expect(getState().theme).toBe('light');
  });

  it('setDesktopNotifications', () => {
    getState().setDesktopNotifications(false);
    expect(getState().desktopNotifications).toBe(false);
  });

  it('setOutputVolume', () => {
    getState().setOutputVolume(0.5);
    expect(getState().outputVolume).toBe(0.5);
  });
});
