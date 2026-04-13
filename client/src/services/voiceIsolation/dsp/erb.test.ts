import { describe, it, expect } from 'vitest';
import {
  freq2erb,
  erb2freq,
  makeErbFilterbank,
  computeBandCorr,
  bandMeanNormErb,
  initMeanNormState,
  bandUnitNorm,
  initUnitNormState,
  applyInterpBandGain,
  calcNormAlpha,
} from './erb';

describe('ERB scale conversions', () => {
  it('roundtrips freq -> erb -> freq', () => {
    for (const f of [0, 100, 1000, 6000, 16000, 24000]) {
      expect(erb2freq(freq2erb(f))).toBeCloseTo(f, 3);
    }
  });

  it('freq2erb is monotonic and zero at 0 Hz', () => {
    expect(freq2erb(0)).toBe(0);
    expect(freq2erb(1000)).toBeGreaterThan(0);
    expect(freq2erb(2000)).toBeGreaterThan(freq2erb(1000));
  });
});

describe('ERB filterbank for DFN3 (sr=48000, fft=960, nb_erb=32, min_nb=2)', () => {
  it('produces 32 bands summing to 481 frequency bins', () => {
    const fb = makeErbFilterbank(48000, 960, 32, 2);
    expect(fb.length).toBe(32);
    let sum = 0;
    for (let i = 0; i < 32; i++) sum += fb[i];
    expect(sum).toBe(481);
  });

  it('low bands have minimum 2 bins each', () => {
    const fb = makeErbFilterbank(48000, 960, 32, 2);
    // Low ERB bands span sub-50-Hz width which is < freqWidth (=50 Hz),
    // so they should be padded up to min_nb_freqs = 2.
    expect(fb[0]).toBeGreaterThanOrEqual(2);
  });

  it('higher bands span more linear bins than lower bands (ERB scale is logarithmic-ish)', () => {
    const fb = makeErbFilterbank(48000, 960, 32, 2);
    // Top band wider than the bottom one.
    expect(fb[31]).toBeGreaterThan(fb[0]);
  });
});

describe('computeBandCorr', () => {
  it('returns mean magnitude squared per band', () => {
    // 4 bands, each 2 bins wide. Spectrum has |X|=1 in band 0, |X|=2 in band 1,
    // 0 in band 2, |X|=3 in band 3.
    const fb = new Uint16Array([2, 2, 2, 2]);
    const spec = new Float32Array(2 * 8); // 8 bins, interleaved
    // band 0
    spec[0] = 1; spec[1] = 0;
    spec[2] = 1; spec[3] = 0;
    // band 1
    spec[4] = 2; spec[5] = 0;
    spec[6] = 0; spec[7] = 2;
    // band 2 stays zero
    // band 3
    spec[12] = 3; spec[13] = 0;
    spec[14] = 0; spec[15] = -3;

    const out = new Float32Array(4);
    computeBandCorr(out, spec, fb);
    expect(out[0]).toBeCloseTo(1);
    expect(out[1]).toBeCloseTo(4);
    expect(out[2]).toBeCloseTo(0);
    expect(out[3]).toBeCloseTo(9);
  });
});

describe('applyInterpBandGain', () => {
  it('broadcasts gains across band bins', () => {
    const fb = new Uint16Array([2, 2]);
    const spec = new Float32Array(2 * 4);
    for (let i = 0; i < 4; i++) {
      spec[2 * i] = 1;
      spec[2 * i + 1] = 0;
    }
    applyInterpBandGain(spec, new Float32Array([0.5, 2]), fb);
    expect(spec[0]).toBeCloseTo(0.5);
    expect(spec[2]).toBeCloseTo(0.5);
    expect(spec[4]).toBeCloseTo(2);
    expect(spec[6]).toBeCloseTo(2);
  });
});

describe('bandMeanNormErb', () => {
  it('first call subtracts the running mean and divides by 40', () => {
    const xs = new Float32Array([0, -10, 10]);
    const state = new Float32Array([0, 0, 0]);
    const alpha = 0.5;
    bandMeanNormErb(xs, state, alpha);
    // newState = x*(1-α)+s*α = x*0.5 + 0
    // x' = (x - newState)/40 = (x - x/2)/40 = x/80
    expect(xs[0]).toBeCloseTo(0);
    expect(xs[1]).toBeCloseTo(-10 / 80);
    expect(xs[2]).toBeCloseTo(10 / 80);
  });
});

describe('bandUnitNorm', () => {
  it('divides each complex bin by sqrt of running magnitude', () => {
    const xs = new Float32Array([4, 0]); // |x| = 4
    const state = new Float32Array([0]);
    bandUnitNorm(xs, state, 0.5);
    // newState = 4*0.5 + 0 = 2; xs /= sqrt(2)
    expect(state[0]).toBeCloseTo(2);
    expect(xs[0]).toBeCloseTo(4 / Math.sqrt(2));
    expect(xs[1]).toBe(0);
  });
});

describe('initial state vectors', () => {
  it('initMeanNormState ramps from -60 to -90', () => {
    const s = initMeanNormState(32);
    expect(s[0]).toBeCloseTo(-60);
    expect(s[31]).toBeCloseTo(-90);
  });

  it('initUnitNormState ramps from 0.001 to 0.0001', () => {
    const s = initUnitNormState(96);
    expect(s[0]).toBeCloseTo(0.001);
    expect(s[95]).toBeCloseTo(0.0001);
  });
});

describe('calcNormAlpha', () => {
  it('matches the libDF DFN3 default (sr=48000, hop=480, tau=1)', () => {
    const a = calcNormAlpha(48000, 480, 1);
    // exp(-0.01) ≈ 0.9900498, rounded to a precision that keeps a < 1.
    // First precision (10^3) gives round(0.9900498*1000)/1000 = 0.99 -> < 1.
    expect(a).toBeCloseTo(0.99, 4);
  });
});
