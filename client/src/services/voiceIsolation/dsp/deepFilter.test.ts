import { describe, it, expect } from 'vitest';
import { applyDeepFilter } from './deepFilter';

describe('applyDeepFilter', () => {
  it('zeroes the first nbDf bins and leaves higher bins untouched', () => {
    const nbDf = 4;
    const dfOrder = 2;
    const nFreqs = 8;
    // Two frames in the window.
    const f0 = new Float32Array(2 * nFreqs).fill(0);
    const f1 = new Float32Array(2 * nFreqs).fill(0);
    // Coefs all zero -> filtered output is zero in nb_df bins.
    const coefs = new Float32Array(2 * nbDf * dfOrder).fill(0);
    const out = new Float32Array(2 * nFreqs);
    // Pre-fill output with sentinel values.
    for (let i = 0; i < out.length; i++) out[i] = 99;
    applyDeepFilter([f0, f1], coefs, nbDf, dfOrder, out);
    for (let k = 0; k < nbDf; k++) {
      expect(out[2 * k]).toBe(0);
      expect(out[2 * k + 1]).toBe(0);
    }
    // Higher bins untouched.
    for (let k = nbDf; k < nFreqs; k++) {
      expect(out[2 * k]).toBe(99);
      expect(out[2 * k + 1]).toBe(99);
    }
  });

  it('matches a hand-computed convolution for a 2-frame, 1-bin, order-2 case', () => {
    const nbDf = 1;
    const dfOrder = 2;
    const nFreqs = 1;
    // spec[0] = (1, 0); spec[1] = (0, 1)
    const f0 = new Float32Array([1, 0]);
    const f1 = new Float32Array([0, 1]);
    // coefs: [k=0][t=0] = (2, 0), [k=0][t=1] = (0, 3)
    const coefs = new Float32Array([2, 0, 0, 3]);
    const out = new Float32Array(2 * nFreqs);
    applyDeepFilter([f0, f1], coefs, nbDf, dfOrder, out);
    // Expected: spec[0]*coefs[0] + spec[1]*coefs[1]
    //   = (1+0i)*(2+0i) + (0+1i)*(0+3i)
    //   = (2+0i) + (-3+0i)
    //   = (-1, 0)
    expect(out[0]).toBeCloseTo(-1);
    expect(out[1]).toBeCloseTo(0);
  });

  it('throws when specWindow has fewer frames than dfOrder', () => {
    const nbDf = 1;
    const dfOrder = 3;
    const coefs = new Float32Array(2 * nbDf * dfOrder);
    expect(() =>
      applyDeepFilter([new Float32Array(2)], coefs, nbDf, dfOrder, new Float32Array(2)),
    ).toThrow(/specWindow length/);
  });
});
