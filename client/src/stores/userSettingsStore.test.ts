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
    inputVolume: 1,
    outputVolume: 1,
    desktopNotifications: true,
    soundNotifications: true,
    theme: 'dark',
    density: 'regular',
  });
});

describe('defaults', () => {
  it('has correct default values', () => {
    expect(getState().selectedInputDevice).toBe('default');
    expect(getState().selectedOutputDevice).toBe('default');
    expect(getState().inputThreshold).toBe(0.15);
    expect(getState().inputVolume).toBe(1);
    expect(getState().outputVolume).toBe(1);
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

  it('exposes density default of regular and updates via setter', () => {
    expect(getState().density).toBe('regular');
    getState().setDensity('compact');
    expect(getState().density).toBe('compact');
    getState().setDensity('cozy');
    expect(getState().density).toBe('cozy');
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
    getState().setInputVolume(2);
    expect(getState().inputVolume).toBe(2);
  });

  it('accepts threshold at boundaries', () => {
    getState().setInputThreshold(0);
    expect(getState().inputThreshold).toBe(0);
    getState().setInputThreshold(1);
    expect(getState().inputThreshold).toBe(1);
  });
});

describe('state independence', () => {
  it('changing one setting does not affect others', () => {
    getState().setSelectedInputDevice('mic-2');
    expect(getState().outputVolume).toBe(1);
    expect(getState().theme).toBe('dark');
  });
});

describe('setBaseFontPx clamping', () => {
  it('clamps to min 11 when smaller passed', () => {
    getState().setBaseFontPx(5);
    expect(getState().baseFontPx).toBe(11);
  });

  it('clamps to max 20 when larger passed', () => {
    getState().setBaseFontPx(30);
    expect(getState().baseFontPx).toBe(20);
  });

  it('rounds non-integer values', () => {
    getState().setBaseFontPx(13.7);
    expect(getState().baseFontPx).toBe(14);
  });

  it('accepts values within range', () => {
    getState().setBaseFontPx(16);
    expect(getState().baseFontPx).toBe(16);
  });
});

describe('setReduceMotion + setTheme', () => {
  it('toggles reduceMotion', () => {
    getState().setReduceMotion(true);
    expect(getState().reduceMotion).toBe(true);
    getState().setReduceMotion(false);
    expect(getState().reduceMotion).toBe(false);
  });

  it('setTheme accepts mesh and minimal', () => {
    getState().setTheme('mesh');
    expect(getState().theme).toBe('mesh');
    getState().setTheme('minimal');
    expect(getState().theme).toBe('minimal');
  });
});

describe('setQuietHours', () => {
  it('updates enabled flag', () => {
    getState().setQuietHours({ enabled: true });
    expect(getState().quietHoursEnabled).toBe(true);
  });

  it('updates from/to', () => {
    getState().setQuietHours({ from: '23:00', to: '08:00' });
    expect(getState().quietHoursFrom).toBe('23:00');
    expect(getState().quietHoursTo).toBe('08:00');
  });

  it('partial update preserves untouched fields', () => {
    getState().setQuietHours({ enabled: true, from: '00:00', to: '06:00' });
    getState().setQuietHours({ enabled: false });
    expect(getState().quietHoursEnabled).toBe(false);
    expect(getState().quietHoursFrom).toBe('00:00');
    expect(getState().quietHoursTo).toBe('06:00');
  });
});
