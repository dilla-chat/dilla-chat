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
 * Frame-batching factor. The encoder is called once per BATCH_T input
 * frames. Within a single call, the model's 2-frame look-ahead (pad_feat
 * shift baked into DFN3's training) becomes a within-batch reorder
 * rather than a per-frame phase misalignment, so the streaming output
 * matches libDF's reference behavior. At BATCH_T=8 the algorithmic delay
 * grows from 40 ms to 80 ms, total mouth-to-ear latency ~120 ms — well
 * within the human acceptability threshold (~200 ms) for live two-way
 * voice. See spike 0d in the spike-results memo for the root-cause
 * analysis.
 */
export const BATCH_T = 8;

/**
 * Encoder output bundle. Shapes follow `Dfn3ModelIOSpec` from `types.ts`
 * with the time dimension fixed at T=BATCH_T (one ONNX call processes
 * BATCH_T audio hops). All tensors are typed Float32Array. The worker is
 * responsible for extracting them from `ort.Tensor` outputs.
 */
export interface EncoderOutputs {
  e0: Float32Array; // [1, 64, BATCH_T, 32]
  e1: Float32Array; // [1, 64, BATCH_T, 16]
  e2: Float32Array; // [1, 64, BATCH_T, 8]
  e3: Float32Array; // [1, 64, BATCH_T, 8]
  emb: Float32Array; // [1, BATCH_T, 512]
  c0: Float32Array; // [1, 64, BATCH_T, 96]
  lsnr: Float32Array; // [1, BATCH_T, 1]
}

export interface EncoderInputs {
  featErb: Float32Array; // [1, 1, BATCH_T, 32]
  featSpec: Float32Array; // [1, 2, BATCH_T, 96]
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
  private readonly featErb: Float32Array; // [1, 1, BATCH_T, nb_erb] — accumulator
  private readonly featSpec: Float32Array; // [1, 2, BATCH_T, nb_df] — accumulator
  private readonly tmpErbPower: Float32Array;
  private readonly tmpCplx: Float32Array; // length 2 * nb_df

  // Frame batching state. Per processFrame call we accumulate one slot
  // of features into featErb/featSpec. When `batchFill === BATCH_T`, we
  // call all three sub-graphs (encoder + erb_dec + df_dec) with T=BATCH_T,
  // slice the per-frame ERB masks and DF coefs into a queue, and consume
  // them on the subsequent processFrame calls.
  //
  // The v2 ONNX exports were re-baked with T=BATCH_T, so calling any of
  // the three sub-graphs with T=1 throws a shape mismatch — they all run
  // in lock-step.
  private batchFill = 0;
  // Per-frame ERB masks and DF coefs sliced from the batched decoder
  // outputs. Indexed 0..BATCH_T-1 within a batch.
  private readonly maskCache: Float32Array[] = [];
  private readonly coefsCache: Float32Array[] = [];
  private readonly lsnrCache: Float32Array[] = [];
  // Index into the cache for the next consume.
  private cacheConsumeIdx = 0;
  // Whether the very first batch has been issued. Until it is, the
  // cache is empty and processFrame returns silence (warm-up).
  private firstBatchIssued = false;

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

    // featErb: [1, 1, BATCH_T, nb_erb] — accumulator across BATCH_T frames
    this.featErb = new Float32Array(BATCH_T * hp.nbErb);
    // featSpec: [1, 2, BATCH_T, nb_df]  — channel-major (real then imag),
    // with the time dimension (BATCH_T) inside each channel block. Layout:
    //   [ch=0, t=0..BATCH_T-1, k=0..nb_df-1, ch=1, t=0..BATCH_T-1, k=0..nb_df-1]
    this.featSpec = new Float32Array(2 * BATCH_T * hp.nbDf);
    this.tmpErbPower = new Float32Array(hp.nbErb);
    this.tmpCplx = new Float32Array(2 * hp.nbDf);
  }

  /**
   * Process one `hopSize`-sample input frame and return one `hopSize`-sample
   * cleaned output frame.
   *
   * **Frame batching semantics (Phase 1.5):** the encoder is called once
   * per BATCH_T frames. Per-frame STFT and feature extraction still happen
   * here, but we accumulate the features into a BATCH_T-sized buffer and
   * trigger the encoder run only when the buffer fills. The decoders + DSP
   * still run per-frame using the cached per-frame encoder outputs.
   *
   * Output is delayed by `BATCH_T + lookahead` hops vs. the input. The
   * first BATCH_T calls return zero-filled output (warm-up); from call
   * BATCH_T+1 onwards each call produces a cleaned hop.
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
    droppedY.set(droppedX);

    // 2) ERB log-power features for THIS frame, written into the
    //    accumulator at slot `batchFill`.
    computeBandCorr(this.tmpErbPower, droppedX, this.erbFb);
    for (let i = 0; i < this.hp.nbErb; i++) {
      this.tmpErbPower[i] = Math.log10(this.tmpErbPower[i] + 1e-10) * 10;
    }
    bandMeanNormErb(this.tmpErbPower, this.meanNormState, this.alpha);
    // featErb layout [1, 1, BATCH_T, nb_erb] → row-major offset for slot t:
    //   featErb[t * nb_erb + i]
    {
      const base = this.batchFill * this.hp.nbErb;
      for (let i = 0; i < this.hp.nbErb; i++) {
        this.featErb[base + i] = this.tmpErbPower[i];
      }
    }

    // 3) Complex feat_spec for THIS frame (unit-norm of low-band).
    for (let i = 0; i < 2 * this.hp.nbDf; i++) this.tmpCplx[i] = droppedX[i];
    bandUnitNorm(this.tmpCplx, this.unitNormState, this.alpha);
    // featSpec layout [1, 2, BATCH_T, nb_df] → channel-major:
    //   featSpec[ch * BATCH_T * nb_df + t * nb_df + k]
    {
      const tStride = this.hp.nbDf;
      const chStride = BATCH_T * tStride;
      const baseRe = 0 * chStride + this.batchFill * tStride;
      const baseIm = 1 * chStride + this.batchFill * tStride;
      for (let k = 0; k < this.hp.nbDf; k++) {
        this.featSpec[baseRe + k] = this.tmpCplx[2 * k];
        this.featSpec[baseIm + k] = this.tmpCplx[2 * k + 1];
      }
    }

    this.batchFill++;

    // 4) If we just filled a batch, run encoder + both decoders (all
    //    baked at T=BATCH_T) and slice per-frame ERB masks + DF coefs
    //    into the cache.
    if (this.batchFill === BATCH_T) {
      const encBatched = await this.backend.runEncoder({
        featErb: this.featErb,
        featSpec: this.featSpec,
      });
      // Decoders are baked at T=BATCH_T too — pass the encoder outputs
      // through directly.
      const erbBatched = await this.backend.runErbDecoder({
        emb: encBatched.emb,
        e3: encBatched.e3,
        e2: encBatched.e2,
        e1: encBatched.e1,
        e0: encBatched.e0,
      });
      const dfBatched = await this.backend.runDfDecoder({
        emb: encBatched.emb,
        c0: encBatched.c0,
      });

      this.maskCache.length = 0;
      this.coefsCache.length = 0;
      this.lsnrCache.length = 0;
      this.cacheConsumeIdx = 0;

      // ERB mask `m` shape [1, 1, BATCH_T, nb_erb] — time-major.
      // Per-frame slice = contiguous chunk of nb_erb floats.
      for (let t = 0; t < BATCH_T; t++) {
        const buf = new Float32Array(this.hp.nbErb);
        for (let k = 0; k < this.hp.nbErb; k++) {
          buf[k] = erbBatched.m[t * this.hp.nbErb + k];
        }
        this.maskCache.push(buf);
      }
      // DF coefs `coefs` shape [1, BATCH_T, nb_df, 2*df_order].
      const coefsPerFrame = this.hp.nbDf * this.hp.dfOrder * 2;
      for (let t = 0; t < BATCH_T; t++) {
        const buf = new Float32Array(coefsPerFrame);
        const base = t * coefsPerFrame;
        for (let k = 0; k < coefsPerFrame; k++) {
          buf[k] = dfBatched.coefs[base + k];
        }
        this.coefsCache.push(buf);
      }
      // lsnr shape [1, BATCH_T, 1]: contiguous BATCH_T scalars.
      for (let t = 0; t < BATCH_T; t++) {
        const buf = new Float32Array(1);
        buf[0] = encBatched.lsnr[t];
        this.lsnrCache.push(buf);
      }

      this.batchFill = 0;
      this.firstBatchIssued = true;
    }

    // 5) Warmup: no decoder output yet → emit silence.
    if (!this.firstBatchIssued || this.cacheConsumeIdx >= this.maskCache.length) {
      output.fill(0);
      return 0;
    }

    // 6) Consume the next per-frame mask + coefs.
    const m = this.maskCache[this.cacheConsumeIdx];
    const coefs = this.coefsCache[this.cacheConsumeIdx];
    const lsnr = this.lsnrCache[this.cacheConsumeIdx];
    this.cacheConsumeIdx++;

    // 7) Apply ERB gains to the y-buffer frame at index (df_order - 1).
    const targetIdxLibDf = this.hp.dfOrder - 1;
    const targetY = this.rollingY[targetIdxLibDf];
    applyInterpBandGain(targetY, m, this.erbFb);

    // 8) Deep-filter.
    this.specOut.set(targetY);
    applyDeepFilter(this.rollingX, coefs, this.hp.nbDf, this.hp.dfOrder, this.specOut);

    // 9) iSTFT.
    this.istft.synthesise(this.specOut, output);

    return lsnr[0] ?? 0;
  }
}
