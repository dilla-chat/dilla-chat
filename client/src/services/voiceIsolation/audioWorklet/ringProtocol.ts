// SharedArrayBuffer ring buffer protocol shared between the AudioWorklet
// processor (audio thread) and the inference Worker.
//
// Layout: [writeIdx (Int32), readIdx (Int32)] header followed by `capacity`
// Float32 samples. Indices wrap modulo `capacity`. The buffer is one-slot
// short of full to distinguish empty (read == write) from full.
//
// Concurrency: writer uses Atomics.store to publish a new writeIdx after
// writing samples; reader uses Atomics.load to observe the writeIdx before
// reading. With single-producer single-consumer this is sufficient.

export interface RingBuffer {
  sab: SharedArrayBuffer;
  intView: Int32Array;
  floatView: Float32Array;
  capacity: number;
}

export const HEADER_INTS = 2;
export const HEADER_BYTES = HEADER_INTS * 4;

export function createRing(capacitySamples: number): RingBuffer {
  if (typeof SharedArrayBuffer === 'undefined') {
    throw new Error('SharedArrayBuffer not available — check COOP/COEP headers');
  }
  if (capacitySamples <= 0 || !Number.isInteger(capacitySamples)) {
    throw new Error('Ring buffer capacity must be a positive integer');
  }
  const sab = new SharedArrayBuffer(HEADER_BYTES + capacitySamples * 4);
  return {
    sab,
    intView: new Int32Array(sab, 0, HEADER_INTS),
    floatView: new Float32Array(sab, HEADER_BYTES, capacitySamples),
    capacity: capacitySamples,
  };
}

export function ringAvailable(ring: RingBuffer): number {
  const writeIdx = Atomics.load(ring.intView, 0);
  const readIdx = Atomics.load(ring.intView, 1);
  return (writeIdx - readIdx + ring.capacity) % ring.capacity;
}

export function ringFreeSpace(ring: RingBuffer): number {
  return ring.capacity - ringAvailable(ring) - 1;
}

export function writeFrame(ring: RingBuffer, frame: Float32Array): void {
  const writeIdx = Atomics.load(ring.intView, 0);
  const readIdx = Atomics.load(ring.intView, 1);
  const used = (writeIdx - readIdx + ring.capacity) % ring.capacity;
  const free = ring.capacity - used - 1;
  if (frame.length > free) {
    throw new Error(
      `Ring buffer overflow: tried to write ${frame.length} samples, only ${free} free`,
    );
  }
  for (let i = 0; i < frame.length; i++) {
    ring.floatView[(writeIdx + i) % ring.capacity] = frame[i];
  }
  Atomics.store(ring.intView, 0, (writeIdx + frame.length) % ring.capacity);
}

export function readFrame(ring: RingBuffer, samples: number): Float32Array | null {
  const writeIdx = Atomics.load(ring.intView, 0);
  const readIdx = Atomics.load(ring.intView, 1);
  const available = (writeIdx - readIdx + ring.capacity) % ring.capacity;
  if (available < samples) return null;

  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = ring.floatView[(readIdx + i) % ring.capacity];
  }
  Atomics.store(ring.intView, 1, (readIdx + samples) % ring.capacity);
  return out;
}
