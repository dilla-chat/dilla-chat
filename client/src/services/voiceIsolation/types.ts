// Shared types for the voice isolation pipeline.
//
// The pipeline runs DeepFilterNet 3 (DFN3) inference in a dedicated Worker
// fed by an AudioWorklet via a SharedArrayBuffer ring buffer. DFN3 ships
// as three ONNX sub-graphs (encoder, ERB-band gain decoder, deep-filter
// coefficient decoder) that the Worker hosts as separate ORT sessions.

export type ModelKind = 'dfn3' | 'passthrough';

/** Returned by the Worker after the three DFN3 sub-graphs are loaded. */
export interface ModelHandle {
  kind: 'dfn3';
  version: number;
  /** ORT session ids — one per sub-graph. */
  encoderSessionId: string;
  erbDecoderSessionId: string;
  dfDecoderSessionId: string;
}

/**
 * DFN3 hyperparameters mirrored from the upstream config.ini.
 *
 * `lookaheadFrames` is the sum of conv-lookahead (2) and DF-lookahead (2),
 * giving a total algorithmic delay of `lookaheadFrames * (hopSize / sampleRate) * 1000`
 * = 4 * 10 = 40 ms.
 */
export interface Dfn3ModelIOSpec {
  encoder: {
    inputs: readonly ['feat_erb', 'feat_spec'];
    outputs: readonly ['e0', 'e1', 'e2', 'e3', 'emb', 'c0', 'lsnr'];
  };
  erbDecoder: { outputs: readonly ['m'] };
  dfDecoder: { outputs: readonly ['coefs'] };
  sampleRate: 48000;
  fftSize: 960;
  hopSize: 480;
  nbErb: 32;
  nbDf: 96;
  dfOrder: 5;
  lookaheadFrames: 4;
}

/**
 * Shapes of the streaming state tensors threaded through the three DFN3
 * sub-graphs. The v2 ONNX re-export exposes these as explicit inputs/outputs
 * so the worker can persist the encoder's conv temporal contexts and all
 * three GRU hidden states across T=1 per-frame calls.
 *
 * Names match the ONNX graph tensor names exactly (verified via
 * `onnx.load().graph.input` on the committed `dfn3-v2/*.onnx` files):
 *   - `erb_ctx`  — encoder conv lookahead buffer for feat_erb
 *   - `spec_ctx` — encoder conv lookahead buffer for feat_spec
 *   - `h_enc`    — encoder GRU hidden state
 *   - `h_erb`    — ERB decoder GRU hidden state (2 layers)
 *   - `c0_ctx`   — DF decoder conv temporal context on c0
 *   - `h_df`     — DF decoder GRU hidden state (2 layers)
 */
export interface Dfn3StateShapes {
  erb_ctx: readonly number[];
  spec_ctx: readonly number[];
  h_enc: readonly number[];
  h_erb: readonly number[];
  c0_ctx: readonly number[];
  h_df: readonly number[];
}

export interface PerStreamStats {
  framesProcessed: number;
  framesDropped: number;
  medianFrameMs: number;
}

export interface CallState {
  enabled: boolean;
  modelLoaded: boolean;
  outgoingStream: PerStreamStats | null;
  incomingStreams: Map<string, PerStreamStats>;
  cpuDegradeActive: boolean;
}
