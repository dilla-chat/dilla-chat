import { describe, it, expect, beforeEach } from 'vitest';
import { useAudioSettingsStore } from './audioSettingsStore';

function getState() {
  return useAudioSettingsStore.getState();
}

beforeEach(() => {
  useAudioSettingsStore.setState({
    echoCancellation: true,
    noiseSuppression: false,
    autoGainControl: true,
    enhancedNoiseSuppression: true,
    inputProfile: 'voice-isolation',
    noiseSuppressionMode: 'rnnoise',
    pushToTalk: false,
    pushToTalkKey: 'KeyV',
    vadThreshold: 0.5,
    vadGracePeriodMs: 200,
    retroactiveGraceMs: 20,
  });
});

describe('default values', () => {
  it('has correct defaults', () => {
    expect(getState().echoCancellation).toBe(true);
    expect(getState().noiseSuppression).toBe(false);
    expect(getState().autoGainControl).toBe(true);
    expect(getState().enhancedNoiseSuppression).toBe(true);
    expect(getState().inputProfile).toBe('voice-isolation');
    expect(getState().noiseSuppressionMode).toBe('rnnoise');
    expect(getState().pushToTalk).toBe(false);
    expect(getState().pushToTalkKey).toBe('KeyV');
    expect(getState().vadThreshold).toBe(0.5);
    expect(getState().vadGracePeriodMs).toBe(200);
    expect(getState().retroactiveGraceMs).toBe(20);
  });
});

describe('setInputProfile', () => {
  it('voice-isolation sets rnnoise and processing on', () => {
    getState().setInputProfile('studio'); // change first
    getState().setInputProfile('voice-isolation');
    expect(getState().noiseSuppressionMode).toBe('rnnoise');
    expect(getState().noiseSuppression).toBe(false);
    expect(getState().enhancedNoiseSuppression).toBe(true);
    expect(getState().echoCancellation).toBe(true);
    expect(getState().autoGainControl).toBe(true);
  });

  it('studio disables all processing', () => {
    getState().setInputProfile('studio');
    expect(getState().noiseSuppressionMode).toBe('none');
    expect(getState().noiseSuppression).toBe(false);
    expect(getState().enhancedNoiseSuppression).toBe(false);
    expect(getState().echoCancellation).toBe(false);
    expect(getState().autoGainControl).toBe(false);
  });

  it('custom makes no derived changes', () => {
    getState().setInputProfile('studio');
    const before = { ...getState() };
    getState().setInputProfile('custom');
    // Only inputProfile should change
    expect(getState().inputProfile).toBe('custom');
    expect(getState().noiseSuppression).toBe(before.noiseSuppression);
  });

  it('switching profiles round-trips correctly', () => {
    getState().setInputProfile('studio');
    getState().setInputProfile('voice-isolation');
    expect(getState().echoCancellation).toBe(true);
    expect(getState().enhancedNoiseSuppression).toBe(true);
  });
});

describe('setNoiseSuppressionMode', () => {
  it('none disables all suppression', () => {
    getState().setNoiseSuppressionMode('none');
    expect(getState().noiseSuppression).toBe(false);
    expect(getState().enhancedNoiseSuppression).toBe(false);
  });

  it('browser enables native suppression', () => {
    getState().setNoiseSuppressionMode('browser');
    expect(getState().noiseSuppression).toBe(true);
    expect(getState().enhancedNoiseSuppression).toBe(false);
  });

  it('rnnoise enables enhanced suppression', () => {
    getState().setNoiseSuppressionMode('rnnoise');
    expect(getState().noiseSuppression).toBe(false);
    expect(getState().enhancedNoiseSuppression).toBe(true);
  });
});

describe('individual setters', () => {
  it('setEchoCancellation', () => {
    getState().setEchoCancellation(false);
    expect(getState().echoCancellation).toBe(false);
    getState().setEchoCancellation(true);
    expect(getState().echoCancellation).toBe(true);
  });

  it('setNoiseSuppression', () => {
    getState().setNoiseSuppression(true);
    expect(getState().noiseSuppression).toBe(true);
  });

  it('setAutoGainControl', () => {
    getState().setAutoGainControl(false);
    expect(getState().autoGainControl).toBe(false);
  });

  it('setEnhancedNoiseSuppression', () => {
    getState().setEnhancedNoiseSuppression(false);
    expect(getState().enhancedNoiseSuppression).toBe(false);
  });

  it('setPushToTalk', () => {
    getState().setPushToTalk(true);
    expect(getState().pushToTalk).toBe(true);
  });

  it('setPushToTalkKey', () => {
    getState().setPushToTalkKey('Space');
    expect(getState().pushToTalkKey).toBe('Space');
  });

  it('setVadThreshold', () => {
    getState().setVadThreshold(0.8);
    expect(getState().vadThreshold).toBe(0.8);
  });

  it('setVadGracePeriodMs', () => {
    getState().setVadGracePeriodMs(500);
    expect(getState().vadGracePeriodMs).toBe(500);
  });

  it('setRetroactiveGraceMs', () => {
    getState().setRetroactiveGraceMs(50);
    expect(getState().retroactiveGraceMs).toBe(50);
  });
});

describe('getAudioConstraints', () => {
  it('returns correct constraints without deviceId', () => {
    const constraints = getState().getAudioConstraints() as MediaTrackConstraints;
    expect(constraints.echoCancellation).toBe(true);
    expect(constraints.noiseSuppression).toBe(false);
    expect(constraints.autoGainControl).toBe(true);
    expect(constraints.deviceId).toBeUndefined();
  });

  it('includes deviceId when provided', () => {
    const constraints = getState().getAudioConstraints('mic-123') as MediaTrackConstraints;
    expect(constraints.deviceId).toEqual({ exact: 'mic-123' });
  });

  it('skips deviceId for default', () => {
    const constraints = getState().getAudioConstraints('default') as MediaTrackConstraints;
    expect(constraints.deviceId).toBeUndefined();
  });

  it('reflects studio profile constraints', () => {
    getState().setInputProfile('studio');
    const constraints = getState().getAudioConstraints() as MediaTrackConstraints;
    expect(constraints.echoCancellation).toBe(false);
    expect(constraints.noiseSuppression).toBe(false);
    expect(constraints.autoGainControl).toBe(false);
  });

  it('reflects browser noise suppression mode', () => {
    getState().setNoiseSuppressionMode('browser');
    const constraints = getState().getAudioConstraints() as MediaTrackConstraints;
    expect(constraints.noiseSuppression).toBe(true);
  });

  it('returns constraints without deviceId when undefined passed', () => {
    const constraints = getState().getAudioConstraints(undefined) as MediaTrackConstraints;
    expect(constraints.deviceId).toBeUndefined();
  });
});
