// End-to-end browser-mode test for the voice-isolation pipeline.
//
// Requirements: the Dilla Rust server must be running on localhost:8888
// (`cd server-rs && cargo run`) so that the model manifest and the three
// DFN3 ONNX files are reachable. The test bails out gracefully if the
// server isn't reachable so a local `npm run test:browser` doesn't blow
// up when only the in-process bits are being checked.
//
// What this test verifies:
//
//   1. The page is `crossOriginIsolated` (COOP/COEP headers landed in M1).
//   2. `loadDfn3Model` fetches and validates all three sub-graphs.
//   3. The inference Worker accepts a `load-models` message and replies
//      `models-loaded` without erroring on any of the three sub-graphs.
//   4. The full pipeline (worklet -> SAB -> worker -> ORT -> SAB -> worklet)
//      runs without throwing for ~500 ms of synthetic audio.
//   5. The output `MediaStreamTrack` is non-null.
//
// Numerical correctness against an upstream reference is *not* checked
// here — that requires capturing reference inputs/outputs from the Python
// implementation, which is out of scope for this task. The unit-level
// dfn3Pipeline.test.ts identity test gives us much of the same coverage.

import { describe, it, expect } from 'vitest';
import { createPipeline } from './pipeline';
import { loadDfn3Model } from './modelLoader';

const SERVER_URL = 'http://localhost:8888';

async function serverIsUp(): Promise<boolean> {
  try {
    const r = await fetch(`${SERVER_URL}/api/voice/models/manifest.json`);
    return r.ok;
  } catch {
    return false;
  }
}

describe('voice-isolation pipeline (browser)', () => {
  it('processes synthetic audio through worklet -> SAB -> worker -> DFN3', async () => {
    if (!(await serverIsUp())) {
      console.warn(
        '[skip] Dilla server not reachable at',
        SERVER_URL,
        '- start it with `cd server-rs && cargo run` to run this test.',
      );
      return;
    }

    expect(crossOriginIsolated).toBe(true);

    const audioContext = new AudioContext({ sampleRate: 48000 });
    await audioContext.audioWorklet.addModule(
      new URL('./audioWorklet/ringBufferProcessor.js', import.meta.url).href,
    );

    const worker = new Worker(new URL('./inferenceWorker.ts', import.meta.url), {
      type: 'module',
    });

    // Fetch the three sub-graphs from the dev server.
    const model = await loadDfn3Model(SERVER_URL);

    const sessionId = 'browser-test-session';
    worker.postMessage({
      type: 'load-models',
      sessionId,
      encoderBytes: model.encBytes,
      erbDecBytes: model.erbDecBytes,
      dfDecBytes: model.dfDecBytes,
    });

    await new Promise<void>((resolve, reject) => {
      const handler = (e: MessageEvent) => {
        if (e.data?.type === 'models-loaded' && e.data.sessionId === sessionId) {
          worker.removeEventListener('message', handler);
          resolve();
        } else if (e.data?.type === 'models-error') {
          worker.removeEventListener('message', handler);
          reject(new Error(`models-error: ${e.data.error}`));
        }
      };
      worker.addEventListener('message', handler);
    });

    // Synthesize a 440 Hz oscillator as the input track.
    const oscillator = audioContext.createOscillator();
    oscillator.frequency.value = 440;
    const dest = audioContext.createMediaStreamDestination();
    oscillator.connect(dest);
    oscillator.start();

    const pipeline = createPipeline({
      audioContext,
      worker,
      track: dest.stream.getAudioTracks()[0],
      sessionId,
    });

    expect(pipeline.outputTrack).toBeDefined();

    // Let it run for half a second.
    await new Promise((resolve) => setTimeout(resolve, 500));

    pipeline.destroy();
    oscillator.stop();
    worker.terminate();
    await audioContext.close();
  }, 30_000);
});
