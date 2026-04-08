// Real-FFT for arbitrary (non-power-of-two) sizes via Bluestein's algorithm.
//
// DeepFilterNet 3 uses fft_size = 960 = 2^6 * 3 * 5, which the popular
// pure-JS FFT libraries (fft.js, webfft) do not support — they all require
// power-of-two sizes. We get around that by wrapping an underlying
// power-of-two complex FFT with the chirp-z transform (Bluestein), which
// computes any size-N DFT as a length-(2N-1)-padded convolution evaluated
// with the next power-of-two FFT.
//
// Bluestein identity:
//   nk = (n^2 + k^2 - (k - n)^2) / 2
//   => X_k = w_k * Σ_n (x_n * w_n) * conj(w_{k-n})
//   where w_m = exp(-i*pi*m^2/N).
//
// References:
//   - https://en.wikipedia.org/wiki/Chirp_Z-transform
//   - https://www.dsprelated.com/showarticle/27.php

import FFTLib from 'fft.js';

interface PowerOfTwoFFT {
  size: number;
  transform(out: number[] | Float64Array, data: number[] | Float64Array): void;
  inverseTransform(out: number[] | Float64Array, data: number[] | Float64Array): void;
}

type FFTCtor = new (size: number) => PowerOfTwoFFT;
const FFTConstructor = FFTLib as unknown as FFTCtor;

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * Real-input FFT for arbitrary even size N via Bluestein's algorithm.
 *
 * Streaming-friendly: precomputes the chirp + its FFT once and reuses
 * scratch buffers across calls. Not thread-safe — instantiate one per
 * worker.
 */
export class RealFFT {
  readonly size: number;
  readonly freqSize: number; // N/2 + 1

  private readonly m: number; // power-of-two convolution length
  private readonly fft: PowerOfTwoFFT;

  // Bluestein chirp w_k = exp(-i*pi*k^2/N), packed [re,im] interleaved.
  // Length 2N.
  private readonly w: Float64Array;
  // Pre-FFTed convolution kernel: c[j] = exp(+i*pi*j^2/N) (= conj(w_j)),
  // zero-padded symmetrically into a length-M sequence and FFTed once.
  // Length 2M.
  private readonly cFFT: Float64Array;

  // Scratch (length 2M) reused across calls.
  private readonly scratchA: Float64Array;
  private readonly scratchB: Float64Array;

  constructor(size: number) {
    if (size <= 1) throw new Error(`RealFFT size must be > 1, got ${size}`);
    if ((size & 1) !== 0) {
      throw new Error(`RealFFT size must be even, got ${size}`);
    }
    this.size = size;
    this.freqSize = (size >> 1) + 1;
    this.m = nextPow2(2 * size - 1);
    this.fft = new FFTConstructor(this.m);

    this.w = new Float64Array(2 * size);
    for (let k = 0; k < size; k++) {
      // (k^2) mod (2N) keeps the angle bounded for large N.
      const kk = (k * k) % (2 * size);
      const angle = (Math.PI * kk) / size;
      this.w[2 * k] = Math.cos(angle);
      this.w[2 * k + 1] = -Math.sin(angle);
    }

    // c[j] = conj(w_j) = exp(+i*pi*j^2/N), zero-padded symmetrically.
    const padded = new Float64Array(2 * this.m);
    for (let k = 0; k < size; k++) {
      const re = this.w[2 * k];
      const im = -this.w[2 * k + 1];
      padded[2 * k] = re;
      padded[2 * k + 1] = im;
      if (k > 0) {
        const j = this.m - k;
        padded[2 * j] = re;
        padded[2 * j + 1] = im;
      }
    }
    this.cFFT = new Float64Array(2 * this.m);
    this.fft.transform(this.cFFT as unknown as number[], padded as unknown as number[]);

    this.scratchA = new Float64Array(2 * this.m);
    this.scratchB = new Float64Array(2 * this.m);
  }

  /**
   * Compute Bluestein convolution: given complex sequence (xRe, xIm) of
   * length N (interleaved? no — separate read), produce complex DFT
   * X_k = Σ_n x_n * exp(-2πi nk/N) for k in 0..N-1, written interleaved
   * to `out` (length 2N).
   *
   * `readX(k)` returns the complex value at index k (used to allow callers
   * to provide inputs in non-interleaved layouts without copying).
   */
  private bluestein(readXRe: (k: number) => number, readXIm: (k: number) => number, out: Float64Array): void {
    const N = this.size;
    const M = this.m;
    const a = this.scratchA;
    const b = this.scratchB;
    a.fill(0);

    // a_k = x_k * w_k
    for (let k = 0; k < N; k++) {
      const xr = readXRe(k);
      const xi = readXIm(k);
      const wr = this.w[2 * k];
      const wi = this.w[2 * k + 1];
      a[2 * k] = xr * wr - xi * wi;
      a[2 * k + 1] = xr * wi + xi * wr;
    }

    this.fft.transform(b as unknown as number[], a as unknown as number[]);

    // Pointwise b * cFFT -> a
    const ck = this.cFFT;
    for (let i = 0; i < M; i++) {
      const ar = b[2 * i];
      const ai = b[2 * i + 1];
      const br = ck[2 * i];
      const bi = ck[2 * i + 1];
      a[2 * i] = ar * br - ai * bi;
      a[2 * i + 1] = ar * bi + ai * br;
    }

    // IFFT (already /M).
    this.fft.inverseTransform(b as unknown as number[], a as unknown as number[]);

    // X_k = w_k * y_k for k in 0..N-1.
    for (let k = 0; k < N; k++) {
      const yr = b[2 * k];
      const yi = b[2 * k + 1];
      const wr = this.w[2 * k];
      const wi = this.w[2 * k + 1];
      out[2 * k] = yr * wr - yi * wi;
      out[2 * k + 1] = yr * wi + yi * wr;
    }
  }

  /**
   * Forward real FFT. `input` length must equal `this.size`. `out` is filled
   * with the first N/2 + 1 complex bins as interleaved [re0, im0, re1, im1, ...]
   * — length must be 2 * (N/2 + 1) = N + 2.
   */
  forward(input: ArrayLike<number>, out: Float32Array): void {
    if (input.length !== this.size) {
      throw new Error(`forward: input length ${input.length} != ${this.size}`);
    }
    if (out.length !== 2 * this.freqSize) {
      throw new Error(`forward: out length ${out.length} != ${2 * this.freqSize}`);
    }
    const full = this.scratchFull();
    this.bluestein(
      (k) => input[k],
      (_k) => 0,
      full,
    );
    for (let k = 0; k < this.freqSize; k++) {
      out[2 * k] = full[2 * k];
      out[2 * k + 1] = full[2 * k + 1];
    }
  }

  /**
   * Inverse real FFT. `freq` is interleaved [re,im,...] of length
   * `2 * (N/2 + 1)` (the Hermitian half). `out` is filled with N real samples.
   *
   * IDFT trick: x_n = (1/N) * conj( DFT_n(conj(X)) ). We expand the
   * Hermitian half to a full length-N spectrum, conjugate it, run forward
   * Bluestein, take the real part of the result divided by N (for real x
   * the imaginary part is numerical noise).
   */
  inverse(freq: Float32Array, out: Float32Array): void {
    if (freq.length !== 2 * this.freqSize) {
      throw new Error(`inverse: freq length ${freq.length} != ${2 * this.freqSize}`);
    }
    if (out.length !== this.size) {
      throw new Error(`inverse: out length ${out.length} != ${this.size}`);
    }
    const N = this.size;
    const full = this.scratchFull();

    // Build full N-length conjugated spectrum.
    // For k in [0, N/2]: a_k = conj(X_k) = (xr, -xi)
    // For k in [N/2+1, N-1]: X_k = conj(X_{N-k}) so conj(X_k) = X_{N-k} = (xr, xi)
    // We supply via callbacks rather than allocating an intermediate buffer.
    this.bluestein(
      (k) => {
        if (k < this.freqSize) return freq[2 * k];
        return freq[2 * (N - k)];
      },
      (k) => {
        if (k < this.freqSize) return -freq[2 * k + 1];
        return freq[2 * (N - k) + 1];
      },
      full,
    );

    // Take real part of full and divide by N.
    const invN = 1 / N;
    for (let k = 0; k < N; k++) {
      out[k] = full[2 * k] * invN;
    }
  }

  // Reusable scratch for the full N-bin complex result (separate from the
  // pow2-M scratch buffers used inside bluestein()). Allocated lazily.
  private fullScratch?: Float64Array;
  private scratchFull(): Float64Array {
    if (!this.fullScratch) this.fullScratch = new Float64Array(2 * this.size);
    return this.fullScratch;
  }
}
