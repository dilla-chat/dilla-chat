import { describe, it, expect } from 'vitest';
import { makeVorbisWindow, computeWNorm } from './window';

describe('voiceIsolation/dsp/window', () => {
  it('throws for non-positive sizes', () => {
    expect(() => makeVorbisWindow(0)).toThrow();
    expect(() => makeVorbisWindow(-4)).toThrow();
  });

  it('throws for odd sizes', () => {
    expect(() => makeVorbisWindow(7)).toThrow();
    expect(() => makeVorbisWindow(15)).toThrow();
  });

  it('produces a Float32Array of the requested length', () => {
    const w = makeVorbisWindow(960);
    expect(w).toBeInstanceOf(Float32Array);
    expect(w.length).toBe(960);
  });

  it('window is symmetric (Vorbis sin-of-sin window is symmetric)', () => {
    const w = makeVorbisWindow(960);
    for (let i = 0; i < w.length / 2; i++) {
      expect(w[i]).toBeCloseTo(w[w.length - 1 - i], 5);
    }
  });

  it('all values are in [0, 1]', () => {
    const w = makeVorbisWindow(512);
    for (const v of w) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('endpoints are small (window tapers to ~0)', () => {
    const w = makeVorbisWindow(960);
    expect(w[0]).toBeLessThan(0.01);
    expect(w[w.length - 1]).toBeLessThan(0.01);
  });

  it('mid-window value is close to 1 (peak in the centre)', () => {
    const w = makeVorbisWindow(960);
    const mid = w[w.length / 2 - 1];
    expect(mid).toBeGreaterThan(0.95);
  });

  it('w[i]^2 + w[i + N/2]^2 ≈ 1 (Princen-Bradley aka "COLA" identity)', () => {
    // The DeepFilterNet 3 window satisfies the Princen-Bradley
    // condition required for perfect reconstruction with 50% overlap.
    const w = makeVorbisWindow(960);
    const half = w.length / 2;
    for (let i = 0; i < half; i++) {
      const v = w[i] * w[i] + w[i + half] * w[i + half];
      expect(v).toBeCloseTo(1, 5);
    }
  });

  it('computeWNorm = 1 / (windowSize^2 / (2 * frameSize))', () => {
    // libDF convention: forward STFT multiplies the spectrum by wnorm.
    expect(computeWNorm(960, 480)).toBeCloseTo(1 / (960 * 960 / (2 * 480)));
    expect(computeWNorm(1024, 256)).toBeCloseTo(1 / (1024 * 1024 / 512));
  });
});
