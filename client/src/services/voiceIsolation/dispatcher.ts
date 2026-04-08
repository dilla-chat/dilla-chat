// Voice isolation dispatcher.
//
// Orchestrates the asynchronous setup of the DFN3 noise-suppression pipeline
// (model download, AudioContext, AudioWorklet module, inference Worker) and
// exposes simple `processOutgoing` / `processIncoming` entry points that
// WebRTCService calls when wiring local/remote MediaStreamTracks.
//
// Life cycle:
//   1. `initializeVoiceIsolation(serverUrl)` — fire-and-forget from
//      WebRTCService. Fetches the model bundle, spins up a worker + audio
//      context, and resolves to an `InitializedContext` (or `null` on
//      failure — callers then stay in pass-through mode).
//   2. For each outgoing mic track, WebRTCService calls
//      `processOutgoing(ctx, track)`. With a non-null ctx this builds a
//      Pipeline and returns the cleaned output track; with `null` it
//      returns the input track unchanged (pass-through).
//   3. Same for each incoming peer track via `processIncoming(ctx, track,
//      peerId)`.
//   4. On disconnect, `tearDownAll()` destroys all pipelines, terminates the
//      worker, and closes the audio context.

import { diagnostics } from './diagnostics';
import {
  loadDfn3Model,
  type Dfn3Config,
  type LoadedDfn3Model,
} from './modelLoader';
import { createPipeline, type Pipeline } from './pipeline';

interface DiagnosticsUpdateMsg {
  type: 'diagnostics-update';
  streamId: string;
  frameTimeMs?: number;
  dropped?: boolean;
  error?: string;
}

function isDiagnosticsUpdate(data: unknown): data is DiagnosticsUpdateMsg {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === 'diagnostics-update'
  );
}

function handleDiagnosticsMessage(e: MessageEvent): void {
  const data = e.data;
  if (!isDiagnosticsUpdate(data)) return;
  if (typeof data.frameTimeMs === 'number') {
    diagnostics.recordFrame(data.frameTimeMs);
  }
  if (data.dropped) {
    diagnostics.recordDrop();
  }
  if (data.error) {
    diagnostics.recordError(data.error);
  }
}

export interface InitializedContext {
  audioContext: AudioContext;
  worker: Worker;
  sessionId: string;
  config: Dfn3Config;
}

// Module-level singletons. The dispatcher is intentionally process-wide so
// that repeated voice channel joins reuse the same worker + audio context —
// the model weights (~8 MB of ORT sessions) load exactly once per tab.
let context: InitializedContext | null = null;
let initInFlight: Promise<InitializedContext | null> | null = null;
let outgoingPipeline: Pipeline | null = null;
const incomingPipelines = new Map<string, Pipeline>();

/**
 * Fetch the DFN3 model bundle, spawn the inference worker, and wait for it
 * to confirm the three ORT sessions loaded. Returns the shared
 * `InitializedContext`, or `null` if any step failed — callers should treat
 * a `null` return as "voice isolation unavailable; fall back to
 * pass-through".
 *
 * Idempotent: repeated calls return the existing context (or join an
 * in-flight init).
 */
export async function initializeVoiceIsolation(
  serverUrl: string,
): Promise<InitializedContext | null> {
  if (context) return context;
  if (initInFlight) return initInFlight;

  initInFlight = (async (): Promise<InitializedContext | null> => {
    let audioContext: AudioContext | null = null;
    let worker: Worker | null = null;
    try {
      const loaded: LoadedDfn3Model = await loadDfn3Model(serverUrl);

      audioContext = new AudioContext({ sampleRate: loaded.config.sample_rate });
      await audioContext.audioWorklet.addModule(
        new URL('./audioWorklet/ringBufferProcessor.js', import.meta.url).href,
      );

      worker = new Worker(new URL('./inferenceWorker.ts', import.meta.url), {
        type: 'module',
      });
      worker.addEventListener('message', handleDiagnosticsMessage);

      const sessionId = `dfn3-${crypto.randomUUID()}`;

      await new Promise<void>((resolve, reject) => {
        const handler = (e: MessageEvent): void => {
          const data = e.data as { type?: string; sessionId?: string; error?: string } | undefined;
          if (!data || data.sessionId !== sessionId) return;
          if (data.type === 'models-loaded') {
            worker!.removeEventListener('message', handler);
            resolve();
          } else if (data.type === 'models-error') {
            worker!.removeEventListener('message', handler);
            reject(new Error(data.error ?? 'unknown model load error'));
          }
        };
        worker!.addEventListener('message', handler);
        worker!.postMessage({
          type: 'load-models',
          sessionId,
          encoderBytes: loaded.encBytes,
          erbDecBytes: loaded.erbDecBytes,
          dfDecBytes: loaded.dfDecBytes,
          config: loaded.config,
        });
      });

      context = {
        audioContext,
        worker,
        sessionId,
        config: loaded.config,
      };
      return context;
    } catch (err) {
      console.error('[voiceIsolation] init failed', err);
      // Best-effort cleanup of partially-constructed resources.
      try {
        worker?.terminate();
      } catch {
        /* ignore */
      }
      try {
        await audioContext?.close();
      } catch {
        /* ignore */
      }
      return null;
    } finally {
      initInFlight = null;
    }
  })();

  return initInFlight;
}

export function getContext(): InitializedContext | null {
  return context;
}

/**
 * Wrap an outgoing (mic) track with the DFN3 pipeline. Passes through
 * unchanged when `ctx` is null (init not yet complete / disabled / failed).
 */
export function processOutgoing(
  ctx: InitializedContext | null,
  track: MediaStreamTrack,
): MediaStreamTrack {
  if (!ctx) return track;

  outgoingPipeline?.destroy();
  outgoingPipeline = createPipeline({
    audioContext: ctx.audioContext,
    worker: ctx.worker,
    track,
    sessionId: ctx.sessionId,
  });
  return outgoingPipeline.outputTrack;
}

/**
 * Wrap an incoming (peer) track with the DFN3 pipeline. Keyed by `peerId` so
 * multiple concurrent peers each get their own pipeline. Pass-through on
 * null ctx.
 */
export function processIncoming(
  ctx: InitializedContext | null,
  track: MediaStreamTrack,
  peerId: string,
): MediaStreamTrack {
  if (!ctx) return track;

  incomingPipelines.get(peerId)?.destroy();
  const pipeline = createPipeline({
    audioContext: ctx.audioContext,
    worker: ctx.worker,
    track,
    sessionId: ctx.sessionId,
  });
  incomingPipelines.set(peerId, pipeline);
  return pipeline.outputTrack;
}

export function tearDownPeer(peerId: string): void {
  const p = incomingPipelines.get(peerId);
  if (p) {
    p.destroy();
    incomingPipelines.delete(peerId);
  }
}

export function tearDownOutgoing(): void {
  outgoingPipeline?.destroy();
  outgoingPipeline = null;
}

export function tearDownAll(): void {
  tearDownOutgoing();
  for (const peerId of Array.from(incomingPipelines.keys())) {
    tearDownPeer(peerId);
  }
  if (context) {
    try {
      context.worker.terminate();
    } catch {
      /* ignore */
    }
    try {
      void context.audioContext.close();
    } catch {
      /* ignore */
    }
    context = null;
  }
}

// Test-only helper — wipes the module-level singletons without touching
// real resources. Used by dispatcher.test.ts via beforeEach.
export function resetForTest(): void {
  outgoingPipeline = null;
  incomingPipelines.clear();
  context = null;
  initInFlight = null;
}
