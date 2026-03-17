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
});
