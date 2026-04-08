/// <reference lib="webworker" />
//
// Voice-isolation inference Worker.
//
// Hosts three onnxruntime-web `InferenceSession`s (DFN3 encoder, ERB
// decoder, DF decoder) and runs the host DSP pipeline (`dfn3Pipeline.ts`)
// in a tick loop driven by the AudioWorklet via SharedArrayBuffer ring
// buffers.
//
// Message protocol (main thread -> worker):
//
//   { type: 'load-models', sessionId, encoderBytes, erbDecBytes, dfDecBytes }
//   { type: 'attach-stream', sessionId, streamId, inputSab, outputSab,
//     inputCapacity, outputCapacity }
//   { type: 'detach-stream', streamId }
//
// Replies (worker -> main thread):
//
//   { type: 'models-loaded', sessionId }
//   { type: 'models-error',  sessionId, error }
//   { type: 'stream-stats',  streamId, framesProcessed, framesDropped }
//   { type: 'diagnostics-update', streamId, frameTimeMs?, dropped?, error? }
//     — emitted on every processed frame so the main-thread `diagnostics`
//       singleton can accumulate timings, drop counts, and recent errors.

import * as ort from 'onnxruntime-web';
import {
  DFN3_HYPERPARAMS,
  Dfn3Pipeline,
  type Dfn3InferenceBackend,
  type DfDecoderInputs,
  type DfDecoderOutputs,
  type EncoderInputs,
  type EncoderOutputs,
  type ErbDecoderInputs,
  type ErbDecoderOutputs,
} from './dfn3Pipeline';

// ORT WASM assets are copied to /ort-wasm/ by the postinstall script.
ort.env.wasm.wasmPaths = '/ort-wasm/';
ort.env.wasm.simd = true;

// ----- Message types ---------------------------------------------------------

interface LoadModelsMsg {
  type: 'load-models';
  sessionId: string;
  encoderBytes: Uint8Array;
  erbDecBytes: Uint8Array;
  dfDecBytes: Uint8Array;
}

interface AttachStreamMsg {
  type: 'attach-stream';
  sessionId: string;
  streamId: string;
  inputSab: SharedArrayBuffer;
  outputSab: SharedArrayBuffer;
  inputCapacity: number;
  outputCapacity: number;
}

interface DetachStreamMsg {
  type: 'detach-stream';
  streamId: string;
}

type IncomingMsg = LoadModelsMsg | AttachStreamMsg | DetachStreamMsg;

// ----- ORT-backed inference backend ------------------------------------------

interface Dfn3SessionTrio {
  encoder: ort.InferenceSession;
  erbDec: ort.InferenceSession;
  dfDec: ort.InferenceSession;
}

class OrtBackend implements Dfn3InferenceBackend {
  constructor(private readonly sessions: Dfn3SessionTrio) {}

  async runEncoder(inputs: EncoderInputs): Promise<EncoderOutputs> {
    const { nbErb, nbDf } = DFN3_HYPERPARAMS;
    const feeds = {
      feat_erb: new ort.Tensor('float32', inputs.featErb, [1, 1, 1, nbErb]),
      feat_spec: new ort.Tensor('float32', inputs.featSpec, [1, 2, 1, nbDf]),
    };
    const out = await this.sessions.encoder.run(feeds);
    return {
      e0: out.e0.data as Float32Array,
      e1: out.e1.data as Float32Array,
      e2: out.e2.data as Float32Array,
      e3: out.e3.data as Float32Array,
      emb: out.emb.data as Float32Array,
      c0: out.c0.data as Float32Array,
      lsnr: out.lsnr.data as Float32Array,
    };
  }

  async runErbDecoder(inputs: ErbDecoderInputs): Promise<ErbDecoderOutputs> {
    // Encoder output shapes from spike memo:
    //   emb [1, 1, 512]    e0 [1, 64, 1, 32]    e1 [1, 64, 1, 16]
    //   e2  [1, 64, 1, 8]  e3 [1, 64, 1, 8]
    const feeds = {
      emb: new ort.Tensor('float32', inputs.emb, [1, 1, 512]),
      e3: new ort.Tensor('float32', inputs.e3, [1, 64, 1, 8]),
      e2: new ort.Tensor('float32', inputs.e2, [1, 64, 1, 8]),
      e1: new ort.Tensor('float32', inputs.e1, [1, 64, 1, 16]),
      e0: new ort.Tensor('float32', inputs.e0, [1, 64, 1, 32]),
    };
    const out = await this.sessions.erbDec.run(feeds);
    return { m: out.m.data as Float32Array };
  }

  async runDfDecoder(inputs: DfDecoderInputs): Promise<DfDecoderOutputs> {
    const feeds = {
      emb: new ort.Tensor('float32', inputs.emb, [1, 1, 512]),
      c0: new ort.Tensor('float32', inputs.c0, [1, 64, 1, 96]),
    };
    const out = await this.sessions.dfDec.run(feeds);
    // df_dec output: 'coefs' shape [1, 1, nb_df, 2*df_order]. The host
    // expects layout [nb_df, df_order] interleaved re/im — i.e. exactly the
    // raw memory of the [nb_df, 2*df_order] tensor (last axis = 2*df_order
    // = 10), where each pair (re, im) is one tap. dfn3Pipeline reads it as
    // `coefs[2 * (k * dfOrder + t) + 0/1]` which lines up.
    return { coefs: out.coefs.data as Float32Array };
  }
}

// ----- Worker state ----------------------------------------------------------

interface SessionEntry {
  trio: Dfn3SessionTrio;
  backend: OrtBackend;
}

interface StreamEntry {
  sessionId: string;
  pipeline: Dfn3Pipeline;
  inputSab: SharedArrayBuffer;
  outputSab: SharedArrayBuffer;
  inputInts: Int32Array;
  inputFloats: Float32Array;
  outputInts: Int32Array;
  outputFloats: Float32Array;
  inputCapacity: number;
  outputCapacity: number;
  active: boolean;
  framesProcessed: number;
  framesDropped: number;
}

const sessions = new Map<string, SessionEntry>();
const streams = new Map<string, StreamEntry>();

const HEADER_INTS = 2;
const HEADER_BYTES = HEADER_INTS * 4;

function postOut(message: unknown): void {
  (self as unknown as Worker).postMessage(message);
}

self.onmessage = async (e: MessageEvent<IncomingMsg>) => {
  const msg = e.data;

  if (msg.type === 'load-models') {
    try {
      const opts: ort.InferenceSession.SessionOptions = {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      };
      const encoder = await ort.InferenceSession.create(msg.encoderBytes, opts);
      const erbDec = await ort.InferenceSession.create(msg.erbDecBytes, opts);
      const dfDec = await ort.InferenceSession.create(msg.dfDecBytes, opts);
      const trio: Dfn3SessionTrio = { encoder, erbDec, dfDec };
      sessions.set(msg.sessionId, { trio, backend: new OrtBackend(trio) });
      postOut({ type: 'models-loaded', sessionId: msg.sessionId });
    } catch (err) {
      postOut({ type: 'models-error', sessionId: msg.sessionId, error: String(err) });
    }
    return;
  }

  if (msg.type === 'attach-stream') {
    const sess = sessions.get(msg.sessionId);
    if (!sess) {
      postOut({
        type: 'stream-error',
        streamId: msg.streamId,
        error: `unknown sessionId ${msg.sessionId}`,
      });
      return;
    }
    const inputInts = new Int32Array(msg.inputSab, 0, HEADER_INTS);
    const inputFloats = new Float32Array(msg.inputSab, HEADER_BYTES, msg.inputCapacity);
    const outputInts = new Int32Array(msg.outputSab, 0, HEADER_INTS);
    const outputFloats = new Float32Array(msg.outputSab, HEADER_BYTES, msg.outputCapacity);
    const entry: StreamEntry = {
      sessionId: msg.sessionId,
      pipeline: new Dfn3Pipeline(sess.backend),
      inputSab: msg.inputSab,
      outputSab: msg.outputSab,
      inputInts,
      inputFloats,
      outputInts,
      outputFloats,
      inputCapacity: msg.inputCapacity,
      outputCapacity: msg.outputCapacity,
      active: true,
      framesProcessed: 0,
      framesDropped: 0,
    };
    streams.set(msg.streamId, entry);
    void runStreamLoop(msg.streamId);
    return;
  }

  if (msg.type === 'detach-stream') {
    const s = streams.get(msg.streamId);
    if (s) s.active = false;
    streams.delete(msg.streamId);
    return;
  }
};

async function runStreamLoop(streamId: string): Promise<void> {
  const HOP = DFN3_HYPERPARAMS.hopSize;
  const inputFrame = new Float32Array(HOP);
  const outputFrame = new Float32Array(HOP);

  while (true) {
    const stream = streams.get(streamId);
    if (!stream || !stream.active) return;

    const writeIdx = Atomics.load(stream.inputInts, 0);
    const readIdx = Atomics.load(stream.inputInts, 1);
    const avail = (writeIdx - readIdx + stream.inputCapacity) % stream.inputCapacity;

    if (avail < HOP) {
      // No full frame available yet — yield and try again.
      await new Promise((resolve) => setTimeout(resolve, 1));
      continue;
    }

    // Read one hop-sized frame from the input ring.
    for (let i = 0; i < HOP; i++) {
      inputFrame[i] = stream.inputFloats[(readIdx + i) % stream.inputCapacity];
    }
    Atomics.store(stream.inputInts, 1, (readIdx + HOP) % stream.inputCapacity);

    const t0 =
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
    let frameError: string | null = null;
    try {
      await stream.pipeline.processFrame(inputFrame, outputFrame);
    } catch (err) {
      console.error('[inferenceWorker] processFrame failed', err);
      outputFrame.fill(0);
      frameError = err instanceof Error ? err.message : String(err);
    }
    const t1 =
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
    const frameTimeMs = t1 - t0;

    // Write to the output ring (drop on overflow).
    const oWrite = Atomics.load(stream.outputInts, 0);
    const oRead = Atomics.load(stream.outputInts, 1);
    const used = (oWrite - oRead + stream.outputCapacity) % stream.outputCapacity;
    const free = stream.outputCapacity - used - 1;
    let dropped = false;
    if (HOP <= free) {
      for (let i = 0; i < HOP; i++) {
        stream.outputFloats[(oWrite + i) % stream.outputCapacity] = outputFrame[i];
      }
      Atomics.store(stream.outputInts, 0, (oWrite + HOP) % stream.outputCapacity);
      stream.framesProcessed += 1;
    } else {
      stream.framesDropped += 1;
      dropped = true;
    }

    // Per-frame diagnostics fan-out. Cheap (one postMessage) and entirely
    // local — never crosses the network.
    postOut({
      type: 'diagnostics-update',
      streamId,
      frameTimeMs: frameError ? undefined : frameTimeMs,
      dropped,
      error: frameError ?? undefined,
    });

    // Periodic stats heartbeat to the main thread.
    if (stream.framesProcessed % 50 === 0) {
      postOut({
        type: 'stream-stats',
        streamId,
        framesProcessed: stream.framesProcessed,
        framesDropped: stream.framesDropped,
      });
    }
  }
}
