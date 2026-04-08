// DeepFilterNet 3 host pipeline.
//
// This module wraps the streaming STFT/iSTFT, ERB feature extraction, and
// deep-filter post-processing around the three ONNX sub-graphs that ship in
// the official DFN3 export. It is the TypeScript counterpart of
// `DfTract::process` in `libDF/src/tract.rs` (Rikorose/DeepFilterNet).
//
// Hyperparameters (DFN3 default — see `config.ini`):
//   sr             = 48000
//   fft_size       = 960   (50 fps, 10 ms per hop)
//   hop_size       = 480
//   nb_erb         = 32    (ERB band gains)
//   nb_df          = 96    (deep-filter low-band bins)
//   df_order       = 5     (deep-filter taps in time)
//   conv_lookahead = 2     (encoder lookahead frames)
//   df_lookahead   = 2     (deep-filter lookahead frames)
//   norm_tau       = 1.0   (feature normalisation time constant)
//
// Algorithmic delay introduced by the pipeline = 4 frames * 10 ms = 40 ms
// (this is on top of the 1-hop STFT framing delay = 10 ms = 50 ms total).
//
// The class has no direct dependency on onnxruntime-web — the inference
// worker is responsible for marshalling tensors in/out of the ORT sessions.
// `processFrame()` calls back into a user-supplied `runEncoder` /
// `runErbDecoder` / `runDfDecoder` interface so this module can be unit-
// tested with stub callbacks.

import { applyDeepFilter } from './dsp/deepFilter';
import {
  applyInterpBandGain,
  bandMeanNormErb,
  bandUnitNorm,
  calcNormAlpha,
  computeBandCorr,
  initMeanNormState,
  initUnitNormState,
  makeErbFilterbank,
} from './dsp/erb';
import { StftAnalyzer, StftSynthesizer } from './dsp/stft';

export interface Dfn3Hyperparameters {
  sampleRate: number;
  fftSize: number;
  hopSize: number;
  nbErb: number;
  nbDf: number;
  dfOrder: number;
  convLookahead: number;
  dfLookahead: number;
  minNbErbFreqs: number;
  normTau: number;
}

export const DFN3_HYPERPARAMS: Dfn3Hyperparameters = {
  sampleRate: 48000,
  fftSize: 960,
  hopSize: 480,
  nbErb: 32,
  nbDf: 96,
  dfOrder: 5,
  convLookahead: 2,
  dfLookahead: 2,
  minNbErbFreqs: 2,
  normTau: 1.0,
};

/**
 * Encoder output bundle. Shapes follow `Dfn3ModelIOSpec` from `types.ts`
 * with the time dimension fixed at T=1 (streaming, one frame at a time).
 *
 * All tensors are typed Float32Array. The worker is responsible for
 * extracting them from `ort.Tensor` outputs.
 */
export interface EncoderOutputs {
  e0: Float32Array; // [1, 64, 1, 32]
  e1: Float32Array; // [1, 64, 1, 16]
  e2: Float32Array; // [1, 64, 1, 8]
  e3: Float32Array; // [1, 64, 1, 8]
  emb: Float32Array; // [1, 1, 512]
  c0: Float32Array; // [1, 64, 1, 96]
  lsnr: Float32Array; // [1, 1, 1]
}

export interface EncoderInputs {
  featErb: Float32Array; // [1, 1, 1, 32]
  featSpec: Float32Array; // [1, 2, 1, 96]
}

export interface ErbDecoderInputs {
  emb: Float32Array;
  e3: Float32Array;
  e2: Float32Array;
  e1: Float32Array;
  e0: Float32Array;
}

export interface DfDecoderInputs {
  emb: Float32Array;
  c0: Float32Array;
}

export interface DfDecoderOutputs {
  /** Complex DF coefs, shape `[1, 1, nb_df, 2*df_order]` interleaved re/im. */
  coefs: Float32Array;
}

export interface ErbDecoderOutputs {
  /** Per-band gains, shape `[1, 1, 1, nb_erb]`. */
  m: Float32Array;
}

/**
 * The async ONNX-running surface the host pipeline depends on. The
 * inference worker provides a concrete implementation backed by three
 * `ort.InferenceSession`s; tests provide stubs.
 */
export interface Dfn3InferenceBackend {
  runEncoder(inputs: EncoderInputs): Promise<EncoderOutputs>;
  runErbDecoder(inputs: ErbDecoderInputs): Promise<ErbDecoderOutputs>;
  runDfDecoder(inputs: DfDecoderInputs): Promise<DfDecoderOutputs>;
}

/**
 * Host pipeline. One instance per stream (mono); not thread-safe.
 *
 * Usage:
 *
 *   const pipe = new Dfn3Pipeline(backend);
 *   for each 480-sample input frame:
 *     const cleaned = await pipe.processFrame(frame);
 *     // cleaned.length === 480; first 4 frames return silence (warm-up).
 */
export class Dfn3Pipeline {
  readonly hp: Dfn3Hyperparameters;
  readonly nFreqs: number;
  readonly alpha: number;

  private readonly stft: StftAnalyzer;
  private readonly istft: StftSynthesizer;
  private readonly erbFb: Uint16Array;
  private readonly meanNormState: Float32Array;
  private readonly unitNormState: Float32Array;

  // Rolling buffers of recent complex spectrograms. libDF maintains two with
  // *different* lengths:
  //   - `rolling_spec_buf_y` has length `df_order + conv_lookahead` and holds
  //     the about-to-be-enhanced spectrum; the ERB gain is applied to
  //     index `df_order - 1`.
  //   - `rolling_spec_buf_x` has length `max(df_order, lookahead)` and holds
  //     the noisy spectrum for the deep filter's causal+lookahead
  //     convolution. The whole buffer is passed to `df()`.
  // Index 0 = oldest. Each entry length = 2 * nFreqs.
  private readonly rollingX: Float32Array[];
  private readonly rollingY: Float32Array[];
  private readonly bufferLenX: number;
  private readonly bufferLenY: number;
  // Per-frame output spectrum (the buffer iSTFT actually consumes).
  private readonly specOut: Float32Array;

  // Reusable scratch tensors.
  private readonly featErb: Float32Array;
  private readonly featSpec: Float32Array;
  private readonly tmpErbPower: Float32Array;
  private readonly tmpCplx: Float32Array; // length 2 * nb_df

  constructor(
    private readonly backend: Dfn3InferenceBackend,
    hp: Dfn3Hyperparameters = DFN3_HYPERPARAMS,
  ) {
    this.hp = hp;
    this.nFreqs = (hp.fftSize >> 1) + 1;
    this.alpha = calcNormAlpha(hp.sampleRate, hp.hopSize, hp.normTau);

    this.stft = new StftAnalyzer({ fftSize: hp.fftSize, hopSize: hp.hopSize });
    this.istft = new StftSynthesizer({ fftSize: hp.fftSize, hopSize: hp.hopSize });

    this.erbFb = makeErbFilterbank(hp.sampleRate, hp.fftSize, hp.nbErb, hp.minNbErbFreqs);
    this.meanNormState = initMeanNormState(hp.nbErb);
    this.unitNormState = initUnitNormState(hp.nbDf);

    // Match libDF buffer sizing exactly (see `DfTract::init`):
    //   y: df_order + conv_lookahead
    //   x: max(df_order, lookahead)   where lookahead = max(conv_lookahead, df_lookahead)
    const lookahead = Math.max(hp.convLookahead, hp.dfLookahead);
    this.bufferLenY = hp.dfOrder + hp.convLookahead;
    this.bufferLenX = Math.max(hp.dfOrder, lookahead);
    this.rollingY = [];
    for (let i = 0; i < this.bufferLenY; i++) {
      this.rollingY.push(new Float32Array(2 * this.nFreqs));
    }
    this.rollingX = [];
    for (let i = 0; i < this.bufferLenX; i++) {
      this.rollingX.push(new Float32Array(2 * this.nFreqs));
    }
    this.specOut = new Float32Array(2 * this.nFreqs);

    this.featErb = new Float32Array(hp.nbErb);
    this.featSpec = new Float32Array(2 * hp.nbDf);
    this.tmpErbPower = new Float32Array(hp.nbErb);
    this.tmpCplx = new Float32Array(2 * hp.nbDf);
  }

  /**
   * Process one `hopSize`-sample input frame and return one `hopSize`-sample
   * cleaned output frame. Output is delayed by `lookahead + 1` hops vs. the
   * input (one hop is the inherent STFT framing delay; the rest comes from
   * the conv + DF lookahead).
   */
  async processFrame(input: Float32Array, output: Float32Array): Promise<number> {
    if (input.length !== this.hp.hopSize) {
      throw new Error(`processFrame: input length ${input.length} != ${this.hp.hopSize}`);
    }
    if (output.length !== this.hp.hopSize) {
      throw new Error(`processFrame: output length ${output.length} != ${this.hp.hopSize}`);
    }

    // 1) STFT the new input frame and place it at the back of both rolling
    //    buffers (noisy + about-to-be-enhanced).
    const droppedX = this.rollingX.shift()!;
    const droppedY = this.rollingY.shift()!;
    droppedX.fill(0);
    droppedY.fill(0);
    this.rollingX.push(droppedX);
    this.rollingY.push(droppedY);
    this.stft.analyse(input, droppedX);
    // y starts as a copy of x; ERB gain is applied to y in step 6.
    droppedY.set(droppedX);

    // 2) ERB log-power features (in place on tmpErbPower).
    computeBandCorr(this.tmpErbPower, droppedX, this.erbFb);
    for (let i = 0; i < this.hp.nbErb; i++) {
      this.tmpErbPower[i] = Math.log10(this.tmpErbPower[i] + 1e-10) * 10;
    }
    bandMeanNormErb(this.tmpErbPower, this.meanNormState, this.alpha);
    // featErb shape [1,1,1,nbErb] — single time step.
    for (let i = 0; i < this.hp.nbErb; i++) this.featErb[i] = this.tmpErbPower[i];

    // 3) Complex feat_spec = unit-norm of low-band spectrum (first nb_df bins).
    for (let i = 0; i < 2 * this.hp.nbDf; i++) this.tmpCplx[i] = droppedX[i];
    bandUnitNorm(this.tmpCplx, this.unitNormState, this.alpha);
    // featSpec layout: ONNX expects [1, 2, T=1, nb_df] where the channel
    // axis splits real/imag. Re-pack.
    for (let k = 0; k < this.hp.nbDf; k++) {
      this.featSpec[k] = this.tmpCplx[2 * k];
      this.featSpec[this.hp.nbDf + k] = this.tmpCplx[2 * k + 1];
    }

    // 4) Run encoder.
    const enc = await this.backend.runEncoder({
      featErb: this.featErb,
      featSpec: this.featSpec,
    });

    // 5) Run ERB decoder + DF decoder. (libDF gates these on lsnr; we
    // always run both for simplicity in Phase 1 and let the ONNX outputs
    // determine the gain — gating is a future optimisation.)
    const erbDec = await this.backend.runErbDecoder({
      emb: enc.emb,
      e3: enc.e3,
      e2: enc.e2,
      e1: enc.e1,
      e0: enc.e0,
    });
    const dfDec = await this.backend.runDfDecoder({
      emb: enc.emb,
      c0: enc.c0,
    });

    // 6) Apply ERB band gains to the y-buffer frame at index (df_order - 1)
    //    from the back, matching libDF's `rolling_spec_buf_y.get_mut(df_order - 1)`.
    //    Note libDF's deque uses index 0 = front (oldest), so `get(df_order - 1)`
    //    is the (df_order - 1)-th-from-front element, which equals
    //    `bufferLen - 1 - (df_order - 1)` from the back when bufferLen = df_order + lookahead.
    //    Wait — libDF uses index `df_order - 1` directly (not `bufferLen - df_order`).
    //    Let me match exactly: `rolling_spec_buf_y[df_order - 1]`.
    const targetIdxLibDf = this.hp.dfOrder - 1;
    const targetY = this.rollingY[targetIdxLibDf];
    applyInterpBandGain(targetY, erbDec.m, this.erbFb);

    // 7) Copy the gained y-frame into specOut, then deep-filter the lowest
    //    nb_df bins of specOut, reading from the full noisy x-buffer. libDF
    //    passes the entire `rolling_spec_buf_x` (length max(df_order,
    //    lookahead) == df_order for DFN3) to `df()` — every frame is used.
    this.specOut.set(targetY);
    applyDeepFilter(this.rollingX, dfDec.coefs, this.hp.nbDf, this.hp.dfOrder, this.specOut);

    // 8) iSTFT specOut to produce hopSize output samples.
    this.istft.synthesise(this.specOut, output);

    // Return local SNR estimate for diagnostics.
    return enc.lsnr[0] ?? 0;
  }
}
