import { describe, it, expect } from 'vitest';
import {
  createRing,
  writeFrame,
  readFrame,
  ringAvailable,
  ringFreeSpace,
} from './ringProtocol';

describe('SAB ring buffer protocol', () => {
  it('round-trips a single frame', () => {
    const ring = createRing(1024);
    const input = new Float32Array(128);
    for (let i = 0; i < 128; i++) input[i] = i / 128;

    writeFrame(ring, input);
    const output = readFrame(ring, 128);

    expect(output).not.toBeNull();
    expect(Array.from(output!)).toEqual(Array.from(input));
  });

  it('returns null when ring has fewer samples than requested', () => {
    const ring = createRing(1024);
    writeFrame(ring, new Float32Array(64));
    expect(readFrame(ring, 128)).toBeNull();
  });

  it('handles wrap-around', () => {
    const ring = createRing(256);
    for (let i = 0; i < 5; i++) {
      writeFrame(ring, new Float32Array(64).fill(i));
      const out = readFrame(ring, 64);
      expect(out).not.toBeNull();
      expect(out![0]).toBe(i);
      expect(out![63]).toBe(i);
    }
  });

  it('throws on overflow', () => {
    const ring = createRing(128);
    expect(() => writeFrame(ring, new Float32Array(256))).toThrow(/overflow/i);
  });

  it('reports available samples and free space', () => {
    const ring = createRing(64);
    expect(ringAvailable(ring)).toBe(0);
    expect(ringFreeSpace(ring)).toBe(63); // capacity - 1

    writeFrame(ring, new Float32Array(10));
    expect(ringAvailable(ring)).toBe(10);
    expect(ringFreeSpace(ring)).toBe(53);

    readFrame(ring, 4);
    expect(ringAvailable(ring)).toBe(6);
    expect(ringFreeSpace(ring)).toBe(57);
  });

  it('preserves sample values across many wrap-around cycles', () => {
    const ring = createRing(33); // odd capacity exposes off-by-one bugs
    let counter = 0;
    for (let cycle = 0; cycle < 20; cycle++) {
      const frame = new Float32Array(7);
      for (let i = 0; i < 7; i++) frame[i] = counter++;
      writeFrame(ring, frame);

      const out = readFrame(ring, 7);
      expect(out).not.toBeNull();
      for (let i = 0; i < 7; i++) {
        expect(out![i]).toBe(counter - 7 + i);
      }
    }
  });
});
