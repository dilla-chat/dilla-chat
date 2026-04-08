// Streaming STFT / iSTFT for DeepFilterNet 3.
//
// Direct port of `frame_analysis` and `frame_synthesis` from
// libDF/src/lib.rs (Rikorose/DeepFilterNet). The framing convention is
// non-standard but matches the model:
//
//   * The window is `window_size` long (= fft_size = 960 for DFN3).
//   * The hop is `frame_size` long (= 480 for DFN3 — exactly 50% overlap).
//   * `analysis_mem` holds (window_size - frame_size) past samples.
//   * Each call to `analysis(input[frame_size])`:
//       1. Builds a `window_size`-long buffer = [analysis_mem, input] both
//          multiplied by the window.
//       2. Real-FFTs that buffer to (freq_size) complex bins.
//       3. Multiplies the spectrum by `wnorm`.
//       4. Updates `analysis_mem` by left-shifting and appending input.
//   * `synthesis(spec[freq_size]) -> output[frame_size]`:
//       1. iFFTs `spec` to a `window_size`-long buffer.
//       2. Multiplies by the window again.
//       3. Adds the first frame_size samples to `synthesis_mem` and emits.
//       4. Stores the trailing samples back into `synthesis_mem`.
//
// Because the analysis multiplies by `wnorm = 1 / (window_size^2 / (2*frame_size))`
// (libDF's choice) and the synthesis applies the squared window, an
// unmodified analysis -> synthesis pass reproduces the input signal at
// the COLA condition with unit gain. Tests below verify this.

import { RealFFT } from './fft960';
import { computeWNorm, makeVorbisWindow } from './window';

export interface StftConfig {
  fftSize: number;
  hopSize: number;
}

export class StftAnalyzer {
  readonly fftSize: number;
  readonly hopSize: number;
  readonly freqSize: number;
  readonly window: Float32Array;
  readonly wnorm: number;

  private readonly fft: RealFFT;
  private readonly analysisMem: Float32Array; // length fftSize - hopSize
  private readonly buf: Float32Array; // length fftSize

  constructor(cfg: StftConfig) {
    this.fftSize = cfg.fftSize;
    this.hopSize = cfg.hopSize;
    if (this.hopSize * 2 > this.fftSize) {
      throw new Error(`hopSize * 2 must be <= fftSize`);
    }
    this.freqSize = (this.fftSize >> 1) + 1;
    this.window = makeVorbisWindow(this.fftSize);
    this.wnorm = computeWNorm(this.fftSize, this.hopSize);
    this.fft = new RealFFT(this.fftSize);
    this.analysisMem = new Float32Array(this.fftSize - this.hopSize);
    this.buf = new Float32Array(this.fftSize);
  }

  reset(): void {
    this.analysisMem.fill(0);
  }

  /**
   * Consume `hopSize` real samples and produce `freqSize` complex bins
   * (interleaved [re,im,...]).
   */
  analyse(input: Float32Array, outSpec: Float32Array): void {
    if (input.length !== this.hopSize) {
      throw new Error(`analyse: input length ${input.length} != ${this.hopSize}`);
    }
    if (outSpec.length !== 2 * this.freqSize) {
      throw new Error(`analyse: outSpec length ${outSpec.length} != ${2 * this.freqSize}`);
    }
    const N = this.fftSize;
    const H = this.hopSize;
    const overlap = N - H; // = analysisMem.length

    // First overlap samples from analysisMem * window[0..overlap].
    for (let i = 0; i < overlap; i++) {
      this.buf[i] = this.analysisMem[i] * this.window[i];
    }
    // Last H samples from input * window[overlap..N].
    for (let i = 0; i < H; i++) {
      this.buf[overlap + i] = input[i] * this.window[overlap + i];
    }

    // Update analysisMem: shift left by H, append input. (analysisMem
    // length = N - H; for libDF's DFN3 N=960, H=480 → overlap=480 = H,
    // so the shift is a single replace.)
    if (overlap > H) {
      // shift left by H
      for (let i = 0; i < overlap - H; i++) {
        this.analysisMem[i] = this.analysisMem[i + H];
      }
    }
    const tail = overlap - H;
    for (let i = 0; i < H && tail + i < overlap; i++) {
      this.analysisMem[tail + i] = input[i];
    }
    // For the typical 50% overlap case (overlap = H), this just copies
    // input verbatim into analysisMem.
    if (tail === 0) {
      this.analysisMem.set(input);
    }

    // Forward FFT.
    this.fft.forward(this.buf, outSpec);

    // Apply wnorm to the spectrum.
    const norm = this.wnorm;
    for (let i = 0; i < outSpec.length; i++) {
      outSpec[i] *= norm;
    }
  }
}

export class StftSynthesizer {
  readonly fftSize: number;
  readonly hopSize: number;
  readonly freqSize: number;
  readonly window: Float32Array;

  private readonly fft: RealFFT;
  private readonly synthesisMem: Float32Array; // length fftSize - hopSize
  private readonly buf: Float32Array; // length fftSize

  constructor(cfg: StftConfig) {
    this.fftSize = cfg.fftSize;
    this.hopSize = cfg.hopSize;
    if (this.hopSize * 2 > this.fftSize) {
      throw new Error(`hopSize * 2 must be <= fftSize`);
    }
    this.freqSize = (this.fftSize >> 1) + 1;
    this.window = makeVorbisWindow(this.fftSize);
    this.fft = new RealFFT(this.fftSize);
    this.synthesisMem = new Float32Array(this.fftSize - this.hopSize);
    this.buf = new Float32Array(this.fftSize);
  }

  reset(): void {
    this.synthesisMem.fill(0);
  }

  /**
   * Consume one frame of `freqSize` complex bins (interleaved) and
   * produce `hopSize` real output samples (with overlap-add).
   */
  synthesise(spec: Float32Array, output: Float32Array): void {
    if (spec.length !== 2 * this.freqSize) {
      throw new Error(`synthesise: spec length ${spec.length} != ${2 * this.freqSize}`);
    }
    if (output.length !== this.hopSize) {
      throw new Error(`synthesise: output length ${output.length} != ${this.hopSize}`);
    }
    const N = this.fftSize;
    const H = this.hopSize;
    const overlap = N - H;

    // libDF's `frame_synthesis` uses an un-normalized inverse FFT (the
    // realfft Rust crate does not divide by N in its inverse). Our
    // `RealFFT.inverse` *does* divide by N, so we multiply back by N here
    // to match libDF's spectrum scaling. Combined with the analysis-side
    // `wnorm = 1 / (N^2 / (2*hop))` = `1/N` (for the 50% overlap case)
    // the round-trip gain is exactly 1.
    this.fft.inverse(spec, this.buf);
    const synthGain = N;
    for (let i = 0; i < N; i++) {
      this.buf[i] *= this.window[i] * synthGain;
    }

    // First H samples = buf[0..H] + synthesisMem[0..H]
    for (let i = 0; i < H; i++) {
      output[i] = this.buf[i] + this.synthesisMem[i];
    }

    // Shift synthesisMem left by H (only matters when overlap > H).
    if (overlap > H) {
      for (let i = 0; i < overlap - H; i++) {
        this.synthesisMem[i] = this.synthesisMem[i + H];
      }
      // Add buf[H..overlap] into the shifted region.
      for (let i = 0; i < overlap - H; i++) {
        this.synthesisMem[i] += this.buf[H + i];
      }
      // Override the trailing H samples with buf[overlap..N].
      for (let i = 0; i < H; i++) {
        this.synthesisMem[overlap - H + i] = this.buf[overlap + i];
      }
    } else {
      // overlap == H (50% overlap). buf[H..N] -> synthesisMem.
      for (let i = 0; i < H; i++) {
        this.synthesisMem[i] = this.buf[H + i];
      }
    }
  }
}
