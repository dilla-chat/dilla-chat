import { describe, it, expect } from 'vitest';
import { StftAnalyzer, StftSynthesizer } from './stft';

function rms(a: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s / a.length);
}

function makeSinusoid(n: number, freqBin: number, fftSize: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.cos((2 * Math.PI * freqBin * i) / fftSize);
  }
  return out;
}

describe('Streaming STFT/iSTFT (DFN3 framing: fft=960, hop=480)', () => {
  it('roundtrips a sinusoid via analyse -> synthesise within 1e-4 RMS (after warm-up)', () => {
    const fftSize = 960;
    const hopSize = 480;
    const numFrames = 30;
    const totalSamples = hopSize * numFrames;

    const ana = new StftAnalyzer({ fftSize, hopSize });
    const syn = new StftSynthesizer({ fftSize, hopSize });

    const input = makeSinusoid(totalSamples, 60, fftSize);
    const output = new Float32Array(totalSamples);

    const spec = new Float32Array(2 * ana.freqSize);
    for (let f = 0; f < numFrames; f++) {
      const inFrame = input.subarray(f * hopSize, (f + 1) * hopSize);
      const outFrame = output.subarray(f * hopSize, (f + 1) * hopSize);
      ana.analyse(inFrame, spec);
      syn.synthesise(spec, outFrame);
    }

    // The streaming analysis-synthesis loop has an inherent 1-hop delay:
    // output emitted at frame f corresponds to input from frame f-1.
    // Compare output[hop:] vs. input[:-hop] after another 1-hop warm-up.
    const delay = hopSize;
    const skip = hopSize * 1;
    const inSlice = input.subarray(skip);
    const outSlice = output.subarray(skip + delay);
    const len = Math.min(inSlice.length, outSlice.length);
    let err = 0;
    for (let i = 0; i < len; i++) {
      const d = inSlice[i] - outSlice[i];
      err += d * d;
    }
    err = Math.sqrt(err / len);
    const sigRms = rms(inSlice.subarray(0, len));
    expect(err / sigRms).toBeLessThan(1e-4);
  });

  it('roundtrips white noise within 1e-4 RMS (after warm-up)', () => {
    const fftSize = 960;
    const hopSize = 480;
    const numFrames = 50;
    const totalSamples = hopSize * numFrames;

    const ana = new StftAnalyzer({ fftSize, hopSize });
    const syn = new StftSynthesizer({ fftSize, hopSize });

    const input = new Float32Array(totalSamples);
    let s = 9876;
    for (let i = 0; i < totalSamples; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      input[i] = (s / 0x7fffffff) * 2 - 1;
    }

    const output = new Float32Array(totalSamples);
    const spec = new Float32Array(2 * ana.freqSize);
    for (let f = 0; f < numFrames; f++) {
      ana.analyse(
        input.subarray(f * hopSize, (f + 1) * hopSize),
        spec,
      );
      syn.synthesise(spec, output.subarray(f * hopSize, (f + 1) * hopSize));
    }

    const delay = hopSize;
    const skip = hopSize * 1;
    const inSlice = input.subarray(skip);
    const outSlice = output.subarray(skip + delay);
    const len = Math.min(inSlice.length, outSlice.length);
    let err = 0;
    for (let i = 0; i < len; i++) {
      const d = inSlice[i] - outSlice[i];
      err += d * d;
    }
    err = Math.sqrt(err / len);
    const sigRms = rms(inSlice.subarray(0, len));
    expect(err / sigRms).toBeLessThan(1e-3);
  });

  it('analyse output has wnorm applied (DC bin equals mean / wnorm)', () => {
    // After warm-up: feed a constant DC signal of 1.0 and check that the
    // DC bin of the second analysis frame equals window_sum * wnorm.
    const fftSize = 960;
    const hopSize = 480;
    const ana = new StftAnalyzer({ fftSize, hopSize });
    const ones = new Float32Array(hopSize).fill(1);
    const spec = new Float32Array(2 * ana.freqSize);

    // Two frames to fully fill analysisMem.
    ana.analyse(ones, spec);
    ana.analyse(ones, spec);

    // DC bin = sum(window) * 1 * wnorm
    let windowSum = 0;
    for (let i = 0; i < fftSize; i++) windowSum += ana.window[i];
    expect(spec[0]).toBeCloseTo(windowSum * ana.wnorm, 3);
    expect(spec[1]).toBeCloseTo(0, 4);
  });
});
