// Deep filter post-processing for DeepFilterNet 3.
//
// Direct port of the `df()` function in `libDF/src/tract.rs`. The deep
// filter is applied to the lowest `nb_df` frequency bins of the
// spectrogram. For each bin k in [0, nb_df) and each output time step t,
//
//   out[t][k] = Σ_{i=0..df_order-1} spec[t - df_order + 1 + i][k] * coefs[k][i]
//
// where `spec` is a rolling buffer of complex spectrograms (length
// >= df_order — the oldest df_order frames feed each output) and `coefs`
// is the deep-filter decoder output for the current frame.
//
// All complex values are stored as interleaved [re, im, re, im, ...]
// Float32Arrays. There is exactly one channel (mono pipeline).

/**
 * Apply the deep filter to the lowest `nbDf` bins of the output spectrogram.
 *
 * @param specWindow A list of `df_order` complex spectrograms, oldest first.
 *   Each entry is interleaved [re,im,...] of length `2 * n_freqs`. The
 *   pipeline maintains this as a rolling deque.
 * @param coefs Complex DF coefficients of shape `[nb_df, df_order]`,
 *   stored as interleaved [re,im,...] of length `2 * nb_df * df_order`,
 *   with the df_order axis as the inner dimension. Layout matches the
 *   ONNX `df_dec.onnx` output after a reshape from `[1, T, nb_df, 10]`.
 * @param nbDf Number of frequency bins covered by the deep filter (96 for DFN3).
 * @param dfOrder Filter order (5 for DFN3).
 * @param outSpec Output spectrogram, complex interleaved length `2 * n_freqs`.
 *   The first `2 * nbDf` floats are overwritten with the filtered values;
 *   the rest are left untouched.
 */
export function applyDeepFilter(
  specWindow: Float32Array[],
  coefs: Float32Array,
  nbDf: number,
  dfOrder: number,
  outSpec: Float32Array,
): void {
  if (specWindow.length < dfOrder) {
    throw new Error(
      `applyDeepFilter: specWindow length ${specWindow.length} < dfOrder ${dfOrder}`,
    );
  }
  if (coefs.length !== 2 * nbDf * dfOrder) {
    throw new Error(
      `applyDeepFilter: coefs length ${coefs.length} != ${2 * nbDf * dfOrder}`,
    );
  }
  // Zero the lowest nb_df bins of the output spectrum.
  for (let k = 0; k < nbDf; k++) {
    outSpec[2 * k] = 0;
    outSpec[2 * k + 1] = 0;
  }
  // The oldest dfOrder frames in the window are used. Mirror libDF: the
  // window may be longer than dfOrder; the convolution always starts at
  // index 0 (the front of the rolling buffer is the oldest frame).
  for (let t = 0; t < dfOrder; t++) {
    const spec = specWindow[t];
    for (let k = 0; k < nbDf; k++) {
      const sr = spec[2 * k];
      const si = spec[2 * k + 1];
      const cIdx = 2 * (k * dfOrder + t);
      const cr = coefs[cIdx];
      const ci = coefs[cIdx + 1];
      outSpec[2 * k] += sr * cr - si * ci;
      outSpec[2 * k + 1] += sr * ci + si * cr;
    }
  }
}
