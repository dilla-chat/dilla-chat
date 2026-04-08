import { describe, it, expect } from 'vitest';
import { RealFFT } from './fft960';

function rms(a: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s / a.length);
}

function diffRms(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s / a.length);
}

describe('RealFFT (Bluestein arbitrary-size real FFT)', () => {
  it('rejects odd sizes', () => {
    expect(() => new RealFFT(7)).toThrow(/even/);
  });

  it('roundtrips a constant signal at N=8', () => {
    const fft = new RealFFT(8);
    const input = new Float32Array(8).fill(1);
    const freq = new Float32Array(2 * fft.freqSize);
    const out = new Float32Array(8);
    fft.forward(input, freq);
    // DC bin should equal sum = 8, all others ~0.
    expect(freq[0]).toBeCloseTo(8, 5);
    expect(freq[1]).toBeCloseTo(0, 5);
    for (let k = 1; k < fft.freqSize; k++) {
      expect(Math.abs(freq[2 * k])).toBeLessThan(1e-5);
      expect(Math.abs(freq[2 * k + 1])).toBeLessThan(1e-5);
    }
    fft.inverse(freq, out);
    for (let i = 0; i < 8; i++) expect(out[i]).toBeCloseTo(1, 5);
  });

  it('roundtrips a sinusoid at N=960 within 1e-4 RMS', () => {
    const N = 960;
    const fft = new RealFFT(N);
    const input = new Float32Array(N);
    // Pick a frequency that lands on a bin (k=120 -> 6 kHz at 48 kHz SR).
    const k = 120;
    for (let n = 0; n < N; n++) {
      input[n] = Math.cos((2 * Math.PI * k * n) / N);
    }
    const freq = new Float32Array(2 * fft.freqSize);
    fft.forward(input, freq);

    // Bin k should have magnitude ~ N/2; all others ~0.
    const mag = (i: number) =>
      Math.hypot(freq[2 * i], freq[2 * i + 1]);
    expect(mag(k)).toBeCloseTo(N / 2, 1);
    for (let i = 0; i < fft.freqSize; i++) {
      if (i === k) continue;
      expect(mag(i)).toBeLessThan(1);
    }

    const out = new Float32Array(N);
    fft.inverse(freq, out);
    expect(diffRms(out, input)).toBeLessThan(1e-4);
  });

  it('roundtrips white noise at N=960 within 1e-4 RMS error', () => {
    const N = 960;
    const fft = new RealFFT(N);
    const input = new Float32Array(N);
    // Deterministic LCG for reproducibility.
    let s = 12345;
    for (let i = 0; i < N; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      input[i] = (s / 0x7fffffff) * 2 - 1;
    }

    const freq = new Float32Array(2 * fft.freqSize);
    const out = new Float32Array(N);
    fft.forward(input, freq);
    fft.inverse(freq, out);

    const err = diffRms(out, input);
    const sigRms = rms(input);
    // Round-trip error should be < 0.01% of signal RMS.
    expect(err / sigRms).toBeLessThan(1e-4);
  });

  it('forward FFT of impulse is flat spectrum', () => {
    const N = 16;
    const fft = new RealFFT(N);
    const input = new Float32Array(N);
    input[0] = 1;
    const freq = new Float32Array(2 * fft.freqSize);
    fft.forward(input, freq);
    for (let k = 0; k < fft.freqSize; k++) {
      expect(freq[2 * k]).toBeCloseTo(1, 5);
      expect(Math.abs(freq[2 * k + 1])).toBeLessThan(1e-5);
    }
  });

  it('matches naive DFT at N=12 (small enough to brute-force)', () => {
    const N = 12;
    const fft = new RealFFT(N);
    const input = new Float32Array(N);
    for (let i = 0; i < N; i++) input[i] = Math.sin((i * 17 + 3) * 0.1);

    const expected = new Float64Array(2 * (N / 2 + 1));
    for (let k = 0; k <= N / 2; k++) {
      let re = 0;
      let im = 0;
      for (let n = 0; n < N; n++) {
        const angle = (-2 * Math.PI * n * k) / N;
        re += input[n] * Math.cos(angle);
        im += input[n] * Math.sin(angle);
      }
      expected[2 * k] = re;
      expected[2 * k + 1] = im;
    }

    const freq = new Float32Array(2 * fft.freqSize);
    fft.forward(input, freq);
    for (let k = 0; k <= N / 2; k++) {
      expect(freq[2 * k]).toBeCloseTo(expected[2 * k], 4);
      expect(freq[2 * k + 1]).toBeCloseTo(expected[2 * k + 1], 4);
    }
  });
});
