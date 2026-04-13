// Local-only voice isolation diagnostics.
//
// Accumulates per-frame timing, frame counts, CPU-degrade events, and a
// bounded ring of recent errors. **Nothing here leaves the device.** The
// VoiceControls status popover reads `diagnostics.snapshot()` on demand.
//
// The inference Worker reports per-frame processing time back to the main
// thread via a `diagnostics-update` postMessage; the dispatcher forwards
// each report into this singleton. Reporting is single-threaded from the
// main thread's perspective, so we don't need Atomics.

/** Max number of frame-time samples retained for percentile computation. */
const FRAME_RING_CAPACITY = 1024;

/** Max number of recent errors retained. */
const ERROR_RING_CAPACITY = 10;

export interface DiagnosticsError {
  timestamp: number;
  message: string;
}

export interface DiagnosticsSnapshot {
  framesProcessed: number;
  framesDropped: number;
  medianFrameMs: number;
  p95FrameMs: number;
  cpuDegradeCount: number;
  errors: DiagnosticsError[];
}

interface DiagnosticsState {
  framesProcessed: number;
  framesDropped: number;
  cpuDegradeCount: number;
  // Ring buffer of recent frame times (ms). Oldest entries get overwritten.
  frameRing: Float64Array;
  frameRingHead: number;
  frameRingCount: number;
  // Bounded queue of recent errors.
  errors: DiagnosticsError[];
}

function createState(): DiagnosticsState {
  return {
    framesProcessed: 0,
    framesDropped: 0,
    cpuDegradeCount: 0,
    frameRing: new Float64Array(FRAME_RING_CAPACITY),
    frameRingHead: 0,
    frameRingCount: 0,
    errors: [],
  };
}

let state: DiagnosticsState = createState();

function computePercentiles(state: DiagnosticsState): {
  median: number;
  p95: number;
} {
  if (state.frameRingCount === 0) return { median: 0, p95: 0 };

  const samples = new Float64Array(state.frameRingCount);
  if (state.frameRingCount < FRAME_RING_CAPACITY) {
    // Ring not yet full — samples are in slots [0..count).
    for (let i = 0; i < state.frameRingCount; i++) {
      samples[i] = state.frameRing[i];
    }
  } else {
    // Ring full; logical order starts at frameRingHead.
    for (let i = 0; i < FRAME_RING_CAPACITY; i++) {
      samples[i] = state.frameRing[(state.frameRingHead + i) % FRAME_RING_CAPACITY];
    }
  }
  samples.sort();

  const n = samples.length;
  const median =
    n % 2 === 0 ? (samples[n / 2 - 1] + samples[n / 2]) / 2 : samples[(n - 1) / 2];

  // Nearest-rank p95: ceil(0.95 * n), 1-indexed => idx = ceil(.95*n)-1
  const p95Idx = Math.max(0, Math.ceil(0.95 * n) - 1);
  const p95 = samples[p95Idx];

  return { median, p95 };
}

export const diagnostics = {
  recordFrame(frameTimeMs: number): void {
    state.framesProcessed += 1;
    state.frameRing[state.frameRingHead] = frameTimeMs;
    state.frameRingHead = (state.frameRingHead + 1) % FRAME_RING_CAPACITY;
    if (state.frameRingCount < FRAME_RING_CAPACITY) state.frameRingCount += 1;
  },

  recordDrop(): void {
    state.framesDropped += 1;
  },

  recordCpuDegrade(): void {
    state.cpuDegradeCount += 1;
  },

  recordError(message: string): void {
    state.errors.push({ timestamp: Date.now(), message });
    if (state.errors.length > ERROR_RING_CAPACITY) {
      state.errors.splice(0, state.errors.length - ERROR_RING_CAPACITY);
    }
  },

  snapshot(): DiagnosticsSnapshot {
    const { median, p95 } = computePercentiles(state);
    return {
      framesProcessed: state.framesProcessed,
      framesDropped: state.framesDropped,
      medianFrameMs: median,
      p95FrameMs: p95,
      cpuDegradeCount: state.cpuDegradeCount,
      // Clone so consumers can't mutate our internal array.
      errors: state.errors.map((e) => ({ ...e })),
    };
  },
};

/** Test-only helper: wipe all accumulated state. */
export function resetDiagnosticsForTest(): void {
  state = createState();
}
