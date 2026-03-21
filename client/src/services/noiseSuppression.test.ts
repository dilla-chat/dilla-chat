import { describe, it, expect } from 'vitest';
import { NoiseSuppression, noiseSuppression } from './noiseSuppression';

describe('NoiseSuppression (no-op stub)', () => {
  it('exports a singleton', () => {
    expect(noiseSuppression).toBeInstanceOf(NoiseSuppression);
  });

  it('isEnabled returns false', () => {
    const ns = new NoiseSuppression();
    expect(ns.isEnabled()).toBe(false);
  });

  it('isInitialized returns false', () => {
    const ns = new NoiseSuppression();
    expect(ns.isInitialized()).toBe(false);
  });

  it('getWorkletNode returns null', () => {
    const ns = new NoiseSuppression();
    expect(ns.getWorkletNode()).toBeNull();
  });

  it('setEnabled is a no-op', () => {
    const ns = new NoiseSuppression();
    expect(() => ns.setEnabled(true)).not.toThrow();
  });

  it('initWorklet is a no-op', async () => {
    const ns = new NoiseSuppression();
    await expect(ns.initWorklet({} as AudioContext)).resolves.toBeUndefined();
  });

  it('waitForReady resolves false', async () => {
    const ns = new NoiseSuppression();
    const result = await ns.waitForReady();
    expect(result).toBe(false);
  });

  it('cleanup is a no-op', () => {
    const ns = new NoiseSuppression();
    expect(() => ns.cleanup()).not.toThrow();
  });

  it('setVadThreshold is a no-op', () => {
    const ns = new NoiseSuppression();
    expect(() => ns.setVadThreshold(0.5)).not.toThrow();
  });

  it('setVadGracePeriodMs is a no-op', () => {
    const ns = new NoiseSuppression();
    expect(() => ns.setVadGracePeriodMs(300)).not.toThrow();
  });

  it('setRetroactiveGraceMs is a no-op', () => {
    const ns = new NoiseSuppression();
    expect(() => ns.setRetroactiveGraceMs(100)).not.toThrow();
  });
});
