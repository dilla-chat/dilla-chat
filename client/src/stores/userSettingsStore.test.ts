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
    expect(getState().selectedOutputDevice).toBe('default');
    expect(getState().inputThreshold).toBe(0.15);
    expect(getState().inputVolume).toBe(1.0);
    expect(getState().outputVolume).toBe(1.0);
    expect(getState().desktopNotifications).toBe(true);
    expect(getState().soundNotifications).toBe(true);
    expect(getState().theme).toBe('dark');
  });
});

describe('setters', () => {
  it('setSelectedInputDevice', () => {
    getState().setSelectedInputDevice('mic-1');
    expect(getState().selectedInputDevice).toBe('mic-1');
  });

  it('setSelectedOutputDevice', () => {
    getState().setSelectedOutputDevice('speaker-1');
    expect(getState().selectedOutputDevice).toBe('speaker-1');
  });

  it('setInputThreshold', () => {
    getState().setInputThreshold(0.5);
    expect(getState().inputThreshold).toBe(0.5);
  });

  it('setInputVolume', () => {
    getState().setInputVolume(0.75);
    expect(getState().inputVolume).toBe(0.75);
  });

  it('setOutputVolume', () => {
    getState().setOutputVolume(0.5);
    expect(getState().outputVolume).toBe(0.5);
  });

  it('setDesktopNotifications', () => {
    getState().setDesktopNotifications(false);
    expect(getState().desktopNotifications).toBe(false);
  });

  it('setSoundNotifications', () => {
    getState().setSoundNotifications(false);
    expect(getState().soundNotifications).toBe(false);
  });

  it('setTheme to light', () => {
    getState().setTheme('light');
    expect(getState().theme).toBe('light');
  });

  it('setTheme back to dark', () => {
    getState().setTheme('light');
    getState().setTheme('dark');
    expect(getState().theme).toBe('dark');
  });
});

describe('volume boundaries', () => {
  it('accepts 0 volume', () => {
    getState().setInputVolume(0);
    expect(getState().inputVolume).toBe(0);
    getState().setOutputVolume(0);
    expect(getState().outputVolume).toBe(0);
  });

  it('accepts max volume', () => {
    getState().setInputVolume(2.0);
    expect(getState().inputVolume).toBe(2.0);
  });

  it('accepts threshold at boundaries', () => {
    getState().setInputThreshold(0);
    expect(getState().inputThreshold).toBe(0);
    getState().setInputThreshold(1.0);
    expect(getState().inputThreshold).toBe(1.0);
  });
});

describe('state independence', () => {
  it('changing one setting does not affect others', () => {
    getState().setSelectedInputDevice('mic-2');
    expect(getState().outputVolume).toBe(1.0);
    expect(getState().theme).toBe('dark');
  });
});
