import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as modelLoader from './modelLoader';
import * as pipelineModule from './pipeline';
import {
  getContext,
  initializeVoiceIsolation,
  processIncoming,
  processOutgoing,
  resetForTest,
  tearDownAll,
  tearDownOutgoing,
  tearDownPeer,
  type InitializedContext,
} from './dispatcher';

// ─── Shared fakes ────────────────────────────────────────────────────────────

class FakeAudioContext {
  sampleRate = 48000;
  audioWorklet = {
    addModule: vi.fn().mockResolvedValue(undefined),
  };
  close = vi.fn().mockResolvedValue(undefined);
}

interface FakeWorkerMessage {
  type: string;
  sessionId?: string;
  [key: string]: unknown;
}

class FakeWorker {
  public posted: FakeWorkerMessage[] = [];
  public terminate = vi.fn();
  private readonly listeners = new Map<
    string,
    Set<(e: MessageEvent) => void>
  >();

  addEventListener(
    type: string,
    handler: (e: MessageEvent) => void,
  ): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(handler);
  }

  removeEventListener(
    type: string,
    handler: (e: MessageEvent) => void,
  ): void {
    this.listeners.get(type)?.delete(handler);
  }

  postMessage(msg: FakeWorkerMessage): void {
    this.posted.push(msg);
  }

  emit(type: string, data: unknown): void {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    const event = { data } as MessageEvent;
    for (const h of listeners) h(event);
  }
}

const FAKE_LOADED_MODEL: modelLoader.LoadedDfn3Model = {
  encBytes: new Uint8Array([1]),
  erbDecBytes: new Uint8Array([2]),
  dfDecBytes: new Uint8Array([3]),
  version: 2,
  config: {
    sample_rate: 48000,
    fft_size: 960,
    hop_size: 480,
    nb_erb: 32,
    nb_df: 96,
    df_order: 5,
    lookahead_frames: 4,
    state_shapes: {
      erb_ctx: [1, 1, 2, 32],
      spec_ctx: [1, 2, 2, 96],
      h_enc: [1, 1, 256],
      h_erb: [2, 1, 256],
      c0_ctx: [1, 64, 4, 96],
      h_df: [2, 1, 256],
    },
  },
};

let workerInstances: FakeWorker[] = [];
let audioContextInstances: FakeAudioContext[] = [];

beforeEach(() => {
  resetForTest();
  workerInstances = [];
  audioContextInstances = [];

  vi.stubGlobal(
    'Worker',
    function FakeWorkerCtor(this: FakeWorker): FakeWorker {
      const w = new FakeWorker();
      workerInstances.push(w);
      return w;
    } as unknown as typeof Worker,
  );
  vi.stubGlobal(
    'AudioContext',
    function FakeAudioContextCtor(this: FakeAudioContext): FakeAudioContext {
      const ctx = new FakeAudioContext();
      audioContextInstances.push(ctx);
      return ctx;
    } as unknown as typeof AudioContext,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('dispatcher — pass-through', () => {
  it('returns null context before init', () => {
    expect(getContext()).toBeNull();
  });

  it('processOutgoing passes through when context is null', () => {
    const fakeTrack = { id: 'a' } as unknown as MediaStreamTrack;
    const result = processOutgoing(null, fakeTrack);
    expect(result).toBe(fakeTrack);
  });

  it('processIncoming passes through when context is null', () => {
    const fakeTrack = { id: 'b' } as unknown as MediaStreamTrack;
    const result = processIncoming(null, fakeTrack, 'peer-1');
    expect(result).toBe(fakeTrack);
  });

  it('tearDown* are safe no-ops when nothing is initialized', () => {
    expect(() => tearDownOutgoing()).not.toThrow();
    expect(() => tearDownPeer('nobody')).not.toThrow();
    expect(() => tearDownAll()).not.toThrow();
  });
});

describe('dispatcher — initializeVoiceIsolation', () => {
  it('returns null when the model loader throws', async () => {
    vi.spyOn(modelLoader, 'loadDfn3Model').mockRejectedValue(
      new modelLoader.ManifestError('network down'),
    );

    const ctx = await initializeVoiceIsolation('http://localhost:8888');
    expect(ctx).toBeNull();
    expect(getContext()).toBeNull();
  });

  it('loads model, spawns worker, awaits model-loaded, caches context', async () => {
    vi.spyOn(modelLoader, 'loadDfn3Model').mockResolvedValue(FAKE_LOADED_MODEL);

    const initPromise = initializeVoiceIsolation('http://localhost:8888');

    // Flush microtasks so loadDfn3Model resolves and the worker is created.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The dispatcher should have created exactly one Worker and posted a
    // load-model message with all three blobs + config.
    expect(workerInstances).toHaveLength(1);
    const worker = workerInstances[0]!;
    const loadMsg = worker.posted.find(
      (m) => m.type === 'load-model' || m.type === 'load-models',
    );
    expect(loadMsg).toBeTruthy();
    expect(loadMsg!.encoderBytes ?? loadMsg!.encBytes).toBeInstanceOf(Uint8Array);
    expect(loadMsg!.erbDecBytes).toBeInstanceOf(Uint8Array);
    expect(loadMsg!.dfDecBytes).toBeInstanceOf(Uint8Array);
    expect(typeof loadMsg!.sessionId).toBe('string');

    // Simulate the worker acknowledging the load.
    worker.emit('message', {
      type: 'models-loaded',
      sessionId: loadMsg!.sessionId,
    });

    const ctx = await initPromise;
    expect(ctx).not.toBeNull();
    expect(getContext()).toBe(ctx);
    expect(audioContextInstances).toHaveLength(1);
    expect(audioContextInstances[0]!.audioWorklet.addModule).toHaveBeenCalled();
  });

  it('returns null when the worker reports models-error', async () => {
    vi.spyOn(modelLoader, 'loadDfn3Model').mockResolvedValue(FAKE_LOADED_MODEL);

    const initPromise = initializeVoiceIsolation('http://localhost:8888');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const worker = workerInstances[0]!;
    const loadMsg = worker.posted.find(
      (m) => m.type === 'load-model' || m.type === 'load-models',
    );
    worker.emit('message', {
      type: 'models-error',
      sessionId: loadMsg!.sessionId,
      error: 'ort blew up',
    });

    const ctx = await initPromise;
    expect(ctx).toBeNull();
    expect(getContext()).toBeNull();
  });

  it('is idempotent — second call returns the same cached context', async () => {
    vi.spyOn(modelLoader, 'loadDfn3Model').mockResolvedValue(FAKE_LOADED_MODEL);

    const first = initializeVoiceIsolation('http://localhost:8888');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const loadMsg = workerInstances[0]!.posted.find(
      (m) => m.type === 'load-model' || m.type === 'load-models',
    );
    workerInstances[0]!.emit('message', {
      type: 'models-loaded',
      sessionId: loadMsg!.sessionId,
    });
    const ctxA = await first;

    const ctxB = await initializeVoiceIsolation('http://localhost:8888');
    expect(ctxB).toBe(ctxA);
    // Still only one worker and one audio context.
    expect(workerInstances).toHaveLength(1);
    expect(audioContextInstances).toHaveLength(1);
  });
});

describe('dispatcher — processing with an initialized context', () => {
  function fakeCtx(): InitializedContext {
    return {
      audioContext: new FakeAudioContext() as unknown as AudioContext,
      worker: new FakeWorker() as unknown as Worker,
      sessionId: 'test-session',
    };
  }

  it('processOutgoing calls createPipeline and returns the output track', () => {
    const outputTrack = { id: 'out' } as unknown as MediaStreamTrack;
    const destroy = vi.fn();
    const spy = vi
      .spyOn(pipelineModule, 'createPipeline')
      .mockReturnValue({ outputTrack, destroy });

    const ctx = fakeCtx();
    const inputTrack = { id: 'in' } as unknown as MediaStreamTrack;
    const result = processOutgoing(ctx, inputTrack);

    expect(spy).toHaveBeenCalledTimes(1);
    const config = spy.mock.calls[0]![0];
    expect(config.track).toBe(inputTrack);
    expect(config.sessionId).toBe('test-session');
    expect(result).toBe(outputTrack);
  });

  it('processOutgoing destroys the previous pipeline when called twice', () => {
    const destroy1 = vi.fn();
    const destroy2 = vi.fn();
    const track1 = { id: 'o1' } as unknown as MediaStreamTrack;
    const track2 = { id: 'o2' } as unknown as MediaStreamTrack;
    vi.spyOn(pipelineModule, 'createPipeline')
      .mockReturnValueOnce({ outputTrack: track1, destroy: destroy1 })
      .mockReturnValueOnce({ outputTrack: track2, destroy: destroy2 });

    const ctx = fakeCtx();
    processOutgoing(ctx, {} as MediaStreamTrack);
    processOutgoing(ctx, {} as MediaStreamTrack);

    expect(destroy1).toHaveBeenCalledTimes(1);
    expect(destroy2).not.toHaveBeenCalled();
  });

  it('processIncoming builds a pipeline per peer and replaces existing ones', () => {
    const destroyA1 = vi.fn();
    const destroyA2 = vi.fn();
    const destroyB = vi.fn();
    vi.spyOn(pipelineModule, 'createPipeline')
      .mockReturnValueOnce({
        outputTrack: { id: 'a1' } as unknown as MediaStreamTrack,
        destroy: destroyA1,
      })
      .mockReturnValueOnce({
        outputTrack: { id: 'b' } as unknown as MediaStreamTrack,
        destroy: destroyB,
      })
      .mockReturnValueOnce({
        outputTrack: { id: 'a2' } as unknown as MediaStreamTrack,
        destroy: destroyA2,
      });

    const ctx = fakeCtx();
    processIncoming(ctx, {} as MediaStreamTrack, 'peer-a');
    processIncoming(ctx, {} as MediaStreamTrack, 'peer-b');
    processIncoming(ctx, {} as MediaStreamTrack, 'peer-a');

    expect(destroyA1).toHaveBeenCalledTimes(1);
    expect(destroyB).not.toHaveBeenCalled();
    expect(destroyA2).not.toHaveBeenCalled();

    tearDownPeer('peer-b');
    expect(destroyB).toHaveBeenCalledTimes(1);
  });

  it('tearDownAll destroys pipelines, terminates worker, closes context', async () => {
    vi.spyOn(modelLoader, 'loadDfn3Model').mockResolvedValue(FAKE_LOADED_MODEL);

    const initPromise = initializeVoiceIsolation('http://localhost:8888');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const worker = workerInstances[0]!;
    const loadMsg = worker.posted.find(
      (m) => m.type === 'load-model' || m.type === 'load-models',
    );
    worker.emit('message', {
      type: 'models-loaded',
      sessionId: loadMsg!.sessionId,
    });
    const ctx = (await initPromise)!;

    const destroyOut = vi.fn();
    const destroyPeer = vi.fn();
    vi.spyOn(pipelineModule, 'createPipeline')
      .mockReturnValueOnce({
        outputTrack: {} as MediaStreamTrack,
        destroy: destroyOut,
      })
      .mockReturnValueOnce({
        outputTrack: {} as MediaStreamTrack,
        destroy: destroyPeer,
      });

    processOutgoing(ctx, {} as MediaStreamTrack);
    processIncoming(ctx, {} as MediaStreamTrack, 'peer-x');

    tearDownAll();

    expect(destroyOut).toHaveBeenCalledTimes(1);
    expect(destroyPeer).toHaveBeenCalledTimes(1);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(audioContextInstances[0]!.close).toHaveBeenCalledTimes(1);
    expect(getContext()).toBeNull();
  });
});
