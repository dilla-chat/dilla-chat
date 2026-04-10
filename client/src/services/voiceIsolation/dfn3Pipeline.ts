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
export const BATCH_T = 32;

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

  // Frame batching state (option 2: buffer input PCM, run entire DSP loop
  // in lockstep when the batch fills).
  //
  // Per processFrame call we store the input PCM in `inputQueue`. When
  // BATCH_T frames have been buffered, we replay the entire DSP pipeline
  // for all BATCH_T frames: STFT, feature extraction, batched encoder +
  // decoders, per-frame gain + DF + iSTFT. The cleaned output PCM goes
  // into `outputQueue`. Subsequent processFrame calls drain `outputQueue`.
  //
  // This approach keeps the rolling buffer state perfectly aligned because
  // the inner DSP loop is identical to BATCH_T sequential single-frame
  // pipeline steps — just with the encoder/decoder calls batched.
  private readonly inputQueue: Float32Array[] = [];
  private readonly outputQueue: Float32Array[] = [];
  private outputDrainIdx = 0;

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

    // Buffer sizing: libDF uses df_order + conv_lookahead for Y and
    // max(df_order, lookahead) for X. With frame batching we push BATCH_T
    // frames before applying masks, so the target frame from the OLDEST
    // batch position must still be in the buffer after all BATCH_T pushes.
    // Extend both buffers by BATCH_T - 1 extra entries.
    const lookahead = Math.max(hp.convLookahead, hp.dfLookahead);
    this.bufferLenY = hp.dfOrder + hp.convLookahead + (BATCH_T - 1);
    this.bufferLenX = Math.max(hp.dfOrder, lookahead) + (BATCH_T - 1);
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
   * **Frame batching (option 2):** input PCM is queued until BATCH_T frames
   * are available. Then the entire DSP loop runs in lockstep: STFT × N →
   * features × N → encoder(T=N) → decoders(T=N) → gain × N → iSTFT × N.
   * The cleaned output hops are queued and drained one per subsequent call.
   *
   * The first BATCH_T calls return silence (warmup). After that each call
   * produces one cleaned hop. Output is delayed by ~BATCH_T hops vs input
   * plus the existing algorithmic delay.
   */
  async processFrame(input: Float32Array, output: Float32Array): Promise<number> {
    if (input.length !== this.hp.hopSize) {
      throw new Error(`processFrame: input length ${input.length} != ${this.hp.hopSize}`);
    }
    if (output.length !== this.hp.hopSize) {
      throw new Error(`processFrame: output length ${output.length} != ${this.hp.hopSize}`);
    }

    // If we have queued output from a previous batch, drain it.
    if (this.outputDrainIdx < this.outputQueue.length) {
      output.set(this.outputQueue[this.outputDrainIdx++]);
      return 0;
    }

    // Queue this input frame.
    this.inputQueue.push(new Float32Array(input));

    // Not enough frames yet → silence.
    if (this.inputQueue.length < BATCH_T) {
      output.fill(0);
      return 0;
    }

    // ---- Full batched DSP loop ----
    // Replay BATCH_T frames through the per-frame DSP (STFT, feature
    // extraction) so the rolling buffers evolve naturally, then call the
    // batched encoder + decoders, then replay the per-frame gain + DF +
    // iSTFT with the per-frame-sliced decoder outputs.

    const { nbErb, nbDf, dfOrder } = this.hp;

    // Phase 1: per-frame STFT + feature extraction → fill featErb/featSpec.
    this.featErb.fill(0);
    this.featSpec.fill(0);
    for (let t = 0; t < BATCH_T; t++) {
      const frame = this.inputQueue[t];

      // STFT → push to rolling buffers.
      const droppedX = this.rollingX.shift()!;
      const droppedY = this.rollingY.shift()!;
      droppedX.fill(0);
      droppedY.fill(0);
      this.rollingX.push(droppedX);
      this.rollingY.push(droppedY);
      this.stft.analyse(frame, droppedX);
      droppedY.set(droppedX);

      // ERB log-power features.
      computeBandCorr(this.tmpErbPower, droppedX, this.erbFb);
      for (let i = 0; i < nbErb; i++) {
        this.tmpErbPower[i] = Math.log10(this.tmpErbPower[i] + 1e-10) * 10;
      }
      bandMeanNormErb(this.tmpErbPower, this.meanNormState, this.alpha);
      const erbBase = t * nbErb;
      for (let i = 0; i < nbErb; i++) {
        this.featErb[erbBase + i] = this.tmpErbPower[i];
      }

      // Complex feat_spec (unit-norm of low-band).
      for (let i = 0; i < 2 * nbDf; i++) this.tmpCplx[i] = droppedX[i];
      bandUnitNorm(this.tmpCplx, this.unitNormState, this.alpha);
      const tStride = nbDf;
      const chStride = BATCH_T * tStride;
      const baseRe = t * tStride;
      const baseIm = chStride + t * tStride;
      for (let k = 0; k < nbDf; k++) {
        this.featSpec[baseRe + k] = this.tmpCplx[2 * k];
        this.featSpec[baseIm + k] = this.tmpCplx[2 * k + 1];
      }
    }

    // Phase 2: batched encoder + decoders (one ONNX call each).
    // Note: pad_feat is NOT applied here. The upstream ONNX encoder
    // sub-graph does NOT include pad_feat (it's applied by the outer
    // DfNet3.forward which we don't call). The encoder operates on
    // raw features. Any temporal alignment offset is handled by the
    // lag search in the regression test.
    const enc = await this.backend.runEncoder({
      featErb: this.featErb,
      featSpec: this.featSpec,
    });
    const erb = await this.backend.runErbDecoder({
      emb: enc.emb,
      e3: enc.e3,
      e2: enc.e2,
      e1: enc.e1,
      e0: enc.e0,
    });
    const df = await this.backend.runDfDecoder({
      emb: enc.emb,
      c0: enc.c0,
    });

    // Phase 3: per-frame gain + DF + iSTFT at the correct buffer offset.
    //
    // The rolling buffers are extended by BATCH_T - 1 entries (constructor),
    // so ALL target frames from the batch are still present after Phase 1.
    // After pushing BATCH_T frames to a buffer of length
    // (dfOrder + convLookahead + BATCH_T - 1), frame t of the batch
    // lands at position (bufferLenY_original - 1 + t) = (dfOrder +
    // convLookahead - 1 + t). The target (dfOrder - 1 hops back from
    // the pushed position) is at position (dfOrder - 1 + t). For t < 2,
    // this points to pre-batch zero entries (warmup → identity output).
    this.outputQueue.length = 0;
    this.outputDrainIdx = 0;
    const coefsPerFrame = nbDf * dfOrder * 2;
    for (let t = 0; t < BATCH_T; t++) {
      const m = erb.m.subarray(t * nbErb, (t + 1) * nbErb);
      const coefs = df.coefs.subarray(t * coefsPerFrame, (t + 1) * coefsPerFrame);

      const targetIdx = dfOrder - 1 + t;
      const targetY = this.rollingY[targetIdx];
      applyInterpBandGain(targetY, m, this.erbFb);

      // DF window: dfOrder contiguous X-buffer frames ending at the target.
      const xTargetIdx = dfOrder - 1 + t;
      const dfWindow = this.rollingX.slice(
        xTargetIdx - dfOrder + 1,
        xTargetIdx + 1,
      );

      this.specOut.set(targetY);
      applyDeepFilter(dfWindow, coefs, nbDf, dfOrder, this.specOut);

      const cleaned = new Float32Array(this.hp.hopSize);
      this.istft.synthesise(this.specOut, cleaned);
      this.outputQueue.push(cleaned);
    }

    // Drain the first output, queue the rest for subsequent calls.
    this.inputQueue.length = 0;
    output.set(this.outputQueue[this.outputDrainIdx++]);
    return enc.lsnr[0] ?? 0;
  }
}
