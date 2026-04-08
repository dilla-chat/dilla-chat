// Equivalent Rectangular Bandwidth (ERB) filterbank used by DeepFilterNet 3.
//
// This is a direct port of `erb_fb`, `freq2erb`, `erb2freq`, `compute_band_corr`,
// `band_mean_norm_erb`, `band_unit_norm`, and `apply_interp_band_gain` from
// `libDF/src/lib.rs` in the upstream Rikorose/DeepFilterNet repo.
//
// The filterbank for DFN3 (sr=48000, fft_size=960, nb_erb=32, min_nb_erb_freqs=2)
// produces 32 band widths summing to 481 (= 960/2 + 1 frequency bins).

export function freq2erb(freqHz: number): number {
  return 9.265 * Math.log1p(freqHz / (24.7 * 9.265));
}

export function erb2freq(nErb: number): number {
  return 24.7 * 9.265 * (Math.exp(nErb / 9.265) - 1);
}

/**
 * Build the ERB band-width vector. Each entry is the number of contiguous
 * linear frequency bins assigned to that ERB band. The sum equals
 * `fft_size / 2 + 1`.
 */
export function makeErbFilterbank(
  sampleRate: number,
  fftSize: number,
  nbBands: number,
  minNbFreqs: number,
): Uint16Array {
  const nyqFreq = sampleRate / 2;
  const freqWidth = sampleRate / fftSize;
  const erbLow = freq2erb(0);
  const erbHigh = freq2erb(nyqFreq);
  const erb = new Uint16Array(nbBands);
  const step = (erbHigh - erbLow) / nbBands;
  let prevFreq = 0;
  let freqOver = 0;
  for (let i = 1; i <= nbBands; i++) {
    const f = erb2freq(erbLow + i * step);
    const fb = Math.round(f / freqWidth);
    let nbFreqs = fb - prevFreq - freqOver;
    if (nbFreqs < minNbFreqs) {
      freqOver = minNbFreqs - nbFreqs;
      nbFreqs = minNbFreqs;
    } else {
      freqOver = 0;
    }
    erb[i - 1] = nbFreqs;
    prevFreq = fb;
  }
  // Add one to the last band to account for fft_size/2 + 1 bins.
  erb[nbBands - 1] += 1;
  let sum = 0;
  for (let i = 0; i < nbBands; i++) sum += erb[i];
  const expected = (fftSize >> 1) + 1;
  const tooLarge = sum - expected;
  if (tooLarge > 0) {
    erb[nbBands - 1] -= tooLarge;
  }
  let check = 0;
  for (let i = 0; i < nbBands; i++) check += erb[i];
  if (check !== expected) {
    throw new Error(`ERB filterbank sum ${check} != expected ${expected}`);
  }
  return erb;
}

/**
 * Per-band power: out_b = (1/W_b) * Σ_{k in band b} |X_k|^2.
 *
 * `spec` is interleaved [re,im,re,im,...] of length 2 * (fftSize/2 + 1).
 * `out` length must equal `erbFb.length` (number of bands).
 *
 * (This corresponds to libDF's `compute_band_corr(out, x, x, erb_fb)`.)
 */
export function computeBandCorr(out: Float32Array, spec: Float32Array, erbFb: Uint16Array): void {
  if (out.length !== erbFb.length) {
    throw new Error(`computeBandCorr: out length ${out.length} != bands ${erbFb.length}`);
  }
  let bcsum = 0;
  for (let b = 0; b < erbFb.length; b++) {
    const bandSize = erbFb[b];
    const k = 1 / bandSize;
    let acc = 0;
    for (let j = 0; j < bandSize; j++) {
      const idx = bcsum + j;
      const re = spec[2 * idx];
      const im = spec[2 * idx + 1];
      acc += (re * re + im * im) * k;
    }
    out[b] = acc;
    bcsum += bandSize;
  }
}

/**
 * Exponential mean normalization on ERB-domain log-power features.
 * Mirrors libDF's `band_mean_norm_erb`:
 *   s = x*(1-α) + s*α
 *   x' = (x - s) / 40
 */
export function bandMeanNormErb(xs: Float32Array, state: Float32Array, alpha: number): void {
  if (xs.length !== state.length) {
    throw new Error(`bandMeanNormErb: xs ${xs.length} != state ${state.length}`);
  }
  for (let i = 0; i < xs.length; i++) {
    const newState = xs[i] * (1 - alpha) + state[i] * alpha;
    state[i] = newState;
    xs[i] = (xs[i] - newState) / 40;
  }
}

/**
 * Initial state for `bandMeanNormErb`. Linearly ramped from -60 dB to -90 dB
 * across the bands, matching `MEAN_NORM_INIT` in libDF.
 */
export function initMeanNormState(nbErb: number): Float32Array {
  const min = -60;
  const max = -90;
  const step = (max - min) / (nbErb - 1);
  const state = new Float32Array(nbErb);
  for (let i = 0; i < nbErb; i++) state[i] = min + i * step;
  return state;
}

/**
 * Per-bin unit-norm normalization on the low-frequency complex spectrum
 * (the deep-filter input feature path). Mirrors libDF's `band_unit_norm`:
 *   s = |x| * (1-α) + s * α
 *   x' = x / sqrt(s)
 *
 * Operates in place on the interleaved [re,im,...] complex array `xs`.
 */
export function bandUnitNorm(xs: Float32Array, state: Float32Array, alpha: number): void {
  const n = state.length;
  if (xs.length !== 2 * n) {
    throw new Error(`bandUnitNorm: xs ${xs.length} != 2 * state ${n}`);
  }
  for (let i = 0; i < n; i++) {
    const re = xs[2 * i];
    const im = xs[2 * i + 1];
    const mag = Math.hypot(re, im);
    const newState = mag * (1 - alpha) + state[i] * alpha;
    state[i] = newState;
    const inv = 1 / Math.sqrt(newState);
    xs[2 * i] = re * inv;
    xs[2 * i + 1] = im * inv;
  }
}

/**
 * Initial state for `bandUnitNorm`. Linearly ramped from 0.001 to 0.0001
 * across the bins, matching `UNIT_NORM_INIT` in libDF.
 */
export function initUnitNormState(nbFreqs: number): Float32Array {
  const min = 0.001;
  const max = 0.0001;
  const step = (max - min) / (nbFreqs - 1);
  const state = new Float32Array(nbFreqs);
  for (let i = 0; i < nbFreqs; i++) state[i] = min + i * step;
  return state;
}

/**
 * Apply per-band gains to a linear-bin complex spectrum, broadcasting each
 * gain across the bins of its band. Mirrors libDF's `apply_interp_band_gain`.
 *
 * `spec` is interleaved [re,im,...] of length 2 * (fftSize/2 + 1). `gains`
 * length equals the number of ERB bands.
 */
export function applyInterpBandGain(
  spec: Float32Array,
  gains: Float32Array,
  erbFb: Uint16Array,
): void {
  if (gains.length !== erbFb.length) {
    throw new Error(`applyInterpBandGain: gains ${gains.length} != bands ${erbFb.length}`);
  }
  let bcsum = 0;
  for (let b = 0; b < erbFb.length; b++) {
    const bandSize = erbFb[b];
    const g = gains[b];
    for (let j = 0; j < bandSize; j++) {
      const idx = bcsum + j;
      spec[2 * idx] *= g;
      spec[2 * idx + 1] *= g;
    }
    bcsum += bandSize;
  }
}

/**
 * Compute the per-frame normalization alpha used by the feature paths.
 * Mirrors libDF's `calc_norm_alpha(sr, hop_size, tau)` — the small-precision
 * rounding loop avoids `alpha == 1.0` exactly.
 */
export function calcNormAlpha(sampleRate: number, hopSize: number, tau: number): number {
  const dt = hopSize / sampleRate;
  const alpha = Math.exp(-dt / tau);
  let a = 1.0;
  let precision = 3;
  while (a >= 1.0) {
    const p = Math.pow(10, precision);
    a = Math.round(alpha * p) / p;
    precision += 1;
    if (precision > 12) break;
  }
  return a;
}
